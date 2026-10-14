import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDirs } from './server.js';
import { run } from './ffmpeg.js';
import { buildTimeline, stillTimes, at } from './timeline.js';
import { checkLayout } from './layout-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(here, '..', '..', 'templates');
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace']);
const FPS = 30;

export const ENCODE = Object.freeze({ codec: 'libx264', crf: 18, pix_fmt: 'yuv420p', preset: 'slow', movflags: '+faststart' });

export class FootageMissingError extends Error {
  constructor(flow, file) {
    super(`scenes reference flow "${flow}" but its recording is missing: ${file}`);
    this.name = 'FootageMissingError';
    this.flow = flow;
  }
}

/** Every footage scene needs its flow's webm in the capture directory. */
export function assertFootageFiles(scenes, captureDir) {
  for (const scene of scenes) {
    if (scene.type !== 'footage') continue;
    const file = path.join(captureDir ?? '', `${scene.flow}.webm`);
    if (!captureDir || !fs.existsSync(file)) throw new FootageMissingError(scene.flow, `${scene.flow}.webm`);
  }
}

export class FontUnavailableError extends Error {
  constructor(font) {
    super(`brand font "${font}" is not installed or loadable in the render browser; install it or choose another font`);
    this.name = 'FontUnavailableError';
    this.font = font;
  }
}

/**
 * Throws unless `font` renders differently from the generic families. An unavailable family
 * falls through to the generic and measures the same as it, for both fallbacks.
 */
export async function assertFontAvailable(page, font) {
  if (GENERIC_FONTS.has(font)) return;
  const available = await page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.textContent = 'mmmmmmmmmmlliWWW 0123456789';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:72px;left:-9999px';
    document.body.append(probe);
    const width = (family) => {
      probe.style.fontFamily = family;
      return probe.getBoundingClientRect().width;
    };
    const quoted = `"${name.replace(/["\\\r\n]/g, '')}"`;
    const differs = ['serif', 'monospace'].some((generic) => width(`${quoted}, ${generic}`) !== width(generic));
    probe.remove();
    return differs;
  }, font);
  if (!available) throw new FontUnavailableError(font);
}

function stageDir(brandScenes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-render-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  for (const f of ['timeline.js', 'geometry.js']) fs.copyFileSync(path.join(here, f), path.join(dir, 'lib', f));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(brandScenes));
  return dir;
}

export async function openCompositor({ scenes, brand, size, captureDir }) {
  const spec = { scenes, brand, size, fps: FPS };
  const dir = stageDir(spec);
  const mounts = [
    { prefix: '/', root: dir },
    { prefix: '/templates', root: TEMPLATES_DIR },
  ];
  if (captureDir) mounts.push({ prefix: '/capture', root: captureDir });
  const server = await serveDirs(mounts);
  let browser;
  const close = async () => {
    await browser?.close().catch(() => {});
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1 });
    await page.goto(`${server.origin}/templates/compositor.html`);
    await assertFontAvailable(page, brand.font);
    await page.evaluate((s) => window.__promo.init(s), spec);
    return {
      page,
      drive: (t) => page.evaluate((time) => window.__promo.renderFrame(time), t),
      shot: () => page.screenshot({ type: 'png', animations: 'allow', caret: 'initial', clip: { x: 0, y: 0, width: size.w, height: size.h } }),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

/** One PNG per scene midpoint and per windowed-transition midpoint; template scenes are layout-checked. */
export async function renderStills({ scenes, brand, size, captureDir, outDir }) {
  assertFootageFiles(scenes, captureDir);
  fs.mkdirSync(outDir, { recursive: true });
  const timeline = buildTimeline(scenes, FPS);
  const c = await openCompositor({ scenes, brand, size, captureDir });
  const files = [];
  const layoutIssues = [];
  try {
    for (const still of stillTimes(timeline)) {
      await c.drive(still.t);
      if (still.kind === 'scene' && scenes[still.index].type !== 'footage') {
        layoutIssues.push(...await checkLayout(c.page, { size, sceneIndex: still.index }));
      }
      const file = path.join(outDir, `${still.name}.png`);
      fs.writeFileSync(file, await c.shot());
      files.push({ kind: still.kind, index: still.index, t: still.t, file });
    }
  } finally {
    await c.close();
  }
  return { files, layoutIssues };
}

/** Tile the images into one PNG, `cols` per row, each scaled to `thumbWidth`. */
export async function makeContactSheet({ ffmpeg, files, out, cols = 3, thumbWidth = 480 }) {
  if (files.length === 0) throw new Error('makeContactSheet: no files');
  const rows = Math.ceil(files.length / cols);
  const inputs = files.flatMap((f) => ['-i', f]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${thumbWidth}:-2,setsar=1[v${i}]`).join(';');
  const chain = files.map((_, i) => `[v${i}]`).join('');
  const graph = `${scaled};${chain}concat=n=${files.length}:v=1:a=0,tile=${cols}x${rows}`;
  await run(ffmpeg, ['-hide_banner', '-y', ...inputs, '-filter_complex', graph, '-frames:v', '1', out]);
}

async function encode({ ffmpeg, framesDir, out, codecArgs }) {
  await run(ffmpeg, ['-hide_banner', '-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.png'), ...codecArgs, out]);
}

/**
 * Render every frame of the master through the compositor and encode it. `doc` is a parsed scenes.json
 * ({ brand, scenes }). Frames are a pure function of the frame index, and frameSequenceSha256 hashes the
 * PNG bytes in order, so identical inputs give an identical sequence.
 */
export async function renderVideo({ scenes: doc, size, captureDir, outFile, workDir, ffmpeg, music = null, webm = false, keepFrames = false }) {
  if (music) throw new Error('renderVideo: music is not supported yet');
  const { scenes, brand } = doc;
  assertFootageFiles(scenes, captureDir);
  const timeline = buildTimeline(scenes, FPS);
  const framesDir = path.join(workDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const hash = crypto.createHash('sha256');
  const layoutIssues = [];
  const c = await openCompositor({ scenes, brand, size, captureDir });
  try {
    // Template scenes are layout-checked once, at the frame nearest their midpoint, when no transition covers it.
    const checkAt = new Map();
    timeline.scenes.forEach((s, index) => {
      if (scenes[index].type !== 'footage') checkAt.set(Math.round((s.start + s.duration / 2) * FPS), index);
    });
    for (let i = 0; i < timeline.frameCount; i += 1) {
      const t = i / FPS;
      await c.drive(t);
      if (checkAt.has(i) && !at(timeline, t).transition) {
        layoutIssues.push(...await checkLayout(c.page, { size, sceneIndex: checkAt.get(i) }));
      }
      const png = await c.shot();
      hash.update(png);
      fs.writeFileSync(path.join(framesDir, `${String(i + 1).padStart(5, '0')}.png`), png);
    }
  } finally {
    await c.close();
  }

  try {
    await encode({
      ffmpeg, framesDir, out: outFile,
      codecArgs: ['-c:v', ENCODE.codec, '-crf', String(ENCODE.crf), '-preset', ENCODE.preset, '-pix_fmt', ENCODE.pix_fmt, '-movflags', ENCODE.movflags],
    });
    if (webm) {
      await encode({
        ffmpeg, framesDir, out: outFile.replace(/\.mp4$/, '.webm'),
        codecArgs: ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p'],
      });
    }
  } finally {
    if (!keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
  }

  const report = {
    version: 1,
    size,
    fps: FPS,
    frames: timeline.frameCount,
    frameSequenceSha256: hash.digest('hex'),
    encode: { ...ENCODE },
    audio: null,
    cueAlignment: [],
    layoutIssues,
  };
  fs.writeFileSync(path.join(path.dirname(outFile), 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
