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
import { safeBand } from './geometry.js';
import {
  DEFAULT_DUCK_DB, DEFAULT_GAIN_DB, buildAudioFilter, duckIntervals,
} from './audio.js';
import { alignmentReport, attributionFor, loadCues, resolveTrack } from './cues.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(here, '..', '..', 'templates');
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace']);
const FPS = 30;

export const ENCODE = Object.freeze({ codec: 'libx264', crf: 18, pix_fmt: 'yuv420p', preset: 'slow', movflags: '+faststart' });

/** A bad command line or an unusable input file: the caller's CLI exits 1. */
export class UsageError extends Error {}

/** The capture step's report.json; a failed or unreadable capture is refused. Returns the per-flow durations. */
export function readCaptureDurations(captureDir) {
  const file = path.join(captureDir, 'report.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read the capture report ${file}: ${e.message}`);
  }
  if (report.status !== 'ok') {
    const why = report.failed ? ` (flow "${report.failed.flow}": ${report.failed.message})` : '';
    throw new UsageError(`capture report ${file} has status "${report.status}"${why}; re-run capture before rendering`);
  }
  return Object.fromEntries((report.flows ?? []).map((f) => [f.name, f.durationSec]));
}

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

export const CAPTION_MODES = Object.freeze(['feed', 'reel']);

/**
 * `captionMode` says where footage captions live: 'feed' (1:1, bottom-anchored with an 8% margin) or
 * 'reel' (9:16, inside the platform safe band). The caption bar is positioned by captionRect(size) in both,
 * and the mode is stamped on the bar as data-caption-mode. 'reel' needs a size that has a safe band.
 */
export async function openCompositor({ scenes, brand, size, captureDir, captionMode = null }) {
  if (captionMode !== null && !CAPTION_MODES.includes(captionMode)) {
    throw new Error(`captionMode must be one of ${CAPTION_MODES.join(', ')}, got "${captionMode}"`);
  }
  if (captionMode === 'reel' && safeBand(size).top === 0) {
    throw new Error(`captionMode "reel" needs a 9:16 size with a safe band, got ${size.w}x${size.h}`);
  }
  const spec = { scenes, brand, size, fps: FPS, captionMode };
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
export async function renderStills({ scenes, brand, size, captureDir, outDir, captionMode = null }) {
  assertFootageFiles(scenes, captureDir);
  fs.mkdirSync(outDir, { recursive: true });
  const timeline = buildTimeline(scenes, FPS);
  const c = await openCompositor({ scenes, brand, size, captureDir, captionMode });
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

/**
 * Layout-check every scene (footage captions included) at its midpoint, before anything is encoded.
 * Returns the issues, each tagged with its scene index; an empty array means the layout is clean.
 */
export async function layoutGate(scenes, brand, size, { captureDir, captionMode = null } = {}) {
  assertFootageFiles(scenes, captureDir);
  const timeline = buildTimeline(scenes, FPS);
  const c = await openCompositor({ scenes, brand, size, captureDir, captionMode });
  const issues = [];
  try {
    for (const still of stillTimes(timeline)) {
      if (still.kind !== 'scene') continue;
      await c.drive(still.t);
      issues.push(...await checkLayout(c.page, { size, sceneIndex: still.index }));
    }
  } finally {
    await c.close();
  }
  return issues;
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

async function encode({ ffmpeg, framesDir, out, codecArgs, audioArgs = [] }) {
  await run(ffmpeg, ['-hide_banner', '-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.png'), ...audioArgs, ...codecArgs, out]);
}

/**
 * Resolve the music track and plan its mix before any frame is rendered, so a missing track or a bad
 * cues file fails fast. `music` is the scenes.json block ({ track, gain_db?, duck_db? }) plus an optional
 * `musicDir` override. The track loops (-stream_loop) when shorter than the video; -t cuts it at the end.
 */
async function planAudio(music, timeline, scenes) {
  const { audio, cues: cuesFile } = resolveTrack(music.track, { musicDir: music.musicDir });
  const cues = await loadCues(cuesFile);
  const gainDb = music.gain_db ?? DEFAULT_GAIN_DB;
  const duckDb = music.duck_db ?? DEFAULT_DUCK_DB;
  const intervals = duckIntervals(timeline, scenes);
  const filter = buildAudioFilter({ gainDb, duckDb, intervals, total: timeline.total });
  const boundaries = timeline.scenes.slice(0, -1).map((s) => s.end);
  return {
    args: [
      '-stream_loop', '-1', '-i', audio,
      '-filter_complex', `[1:a]${filter}[a]`, '-map', '0:v', '-map', '[a]',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-t', String(timeline.total),
    ],
    report: {
      track: music.track, gainDb, duckDb, tempo: cues.tempo, duckIntervals: intervals,
      attribution: await attributionFor(music.track, { musicDir: music.musicDir }),
    },
    alignment: alignmentReport(boundaries, cues),
  };
}

/**
 * Render every frame of the master through the compositor and encode it. `doc` is a parsed scenes.json
 * ({ brand, scenes }). Frames are a pure function of the frame index, and frameSequenceSha256 hashes the
 * PNG bytes in order, so identical inputs give an identical sequence. `music` (null for a silent master)
 * is described on planAudio.
 */
export async function renderVideo({ scenes: doc, size, captureDir, outFile, workDir, ffmpeg, music = null, webm = false, keepFrames = false, captionMode = null, reportFile = 'render-report.json' }) {
  const { scenes, brand } = doc;
  assertFootageFiles(scenes, captureDir);
  const timeline = buildTimeline(scenes, FPS);
  let audio = null;
  const framesDir = path.join(workDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const hash = crypto.createHash('sha256');
  const layoutIssues = [];
  const c = await openCompositor({ scenes, brand, size, captureDir, captionMode });
  try {
    // After the font check (openCompositor) and before any frame: a bad track or cues file fails fast.
    if (music) audio = await planAudio(music, timeline, scenes);
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
      audioArgs: audio?.args,
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
    audio: audio?.report ?? null,
    cueAlignment: audio?.alignment ?? [],
    layoutIssues,
  };
  fs.writeFileSync(path.join(path.dirname(outFile), reportFile), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
