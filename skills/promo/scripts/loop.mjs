#!/usr/bin/env node
// Build a seamless website hero loop from the footage scenes: 8-15 s, no audio, no text, 1920x1080 at 30 fps.
// The loop points sit in the quietest stretches of the footage, and the last 500 ms crossfade into the
// frames just before the start, so the wrap-around is not a visible jump.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadScenes, ValidationError } from './lib/schema.js';
import { FfmpegUnavailableError, requireFfmpeg, run } from './lib/ffmpeg.js';
import { ENCODE, UsageError, assertFootageFiles, readCaptureDurations } from './lib/render-core.js';
import { cropForRatio } from './lib/geometry.js';
import { frameDiffs, pickLoopPoints } from './lib/loop-points.js';
import { createLogger } from './lib/log.js';

const USAGE = 'usage: loop.mjs --scenes <scenes.json> --capture <dir> --out <dir>';
const SIZE = { w: 1920, h: 1080 };
// The capture viewport every flow video is treated as (the compositor's SOURCE).
const SOURCE = { w: 1920, h: 1080 };
const FPS = 30;
const TAIL_SEC = 0.5;
const DIFF_SIZE = { w: 64, h: 36 };

/** The footage scenes' ranges, each cropped to 16:9 around its focus and scaled to the master size, as one lossless clip. */
async function buildSource({ ffmpeg, scenes, captureDir, outFile }) {
  const args = ['-hide_banner', '-y'];
  const chains = [];
  scenes.forEach((scene, i) => {
    args.push('-ss', String(scene.in), '-t', String(scene.out - scene.in), '-i', path.join(captureDir, `${scene.flow}.webm`));
    const { rect } = cropForRatio(scene.focus, SOURCE, SIZE);
    const even = (v) => Math.max(2, 2 * Math.round(v / 2));
    chains.push(`[${i}:v]crop=${even(rect.w)}:${even(rect.h)}:${Math.round(rect.x)}:${Math.round(rect.y)},`
      + `scale=${SIZE.w}:${SIZE.h}:flags=bicubic,fps=${FPS},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  });
  const joined = scenes.map((_, i) => `[v${i}]`).join('');
  chains.push(`${joined}concat=n=${scenes.length}:v=1:a=0[out]`);
  args.push('-filter_complex', chains.join(';'), '-map', '[out]', '-an', '-c:v', 'ffv1', outFile);
  await run(ffmpeg, args);
}

/** The per-frame difference series of the source clip. */
async function sourceDiffs({ ffmpeg, source, rawFile }) {
  await run(ffmpeg, [
    '-hide_banner', '-y', '-i', source,
    '-vf', `scale=${DIFF_SIZE.w}:${DIFF_SIZE.h},format=gray`, '-f', 'rawvideo', rawFile,
  ]);
  const raw = fs.readFileSync(rawFile);
  const size = DIFF_SIZE.w * DIFF_SIZE.h;
  const frames = Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  return frameDiffs(frames);
}

/**
 * Body [start, end-tail) then the tail [end-tail, end) fading into the head-side frames [start-tail, start):
 * frame 0 is F(start) and the last frame is one step short of F(start).
 */
async function renderLoop({ ffmpeg, source, start, end, mp4, webm }) {
  const w = Math.round(TAIL_SEC * FPS);
  const cut = (from, to, label) => `trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS[${label}]`;
  const graph = [
    '[0:v]split=3[a][b][c]',
    `[a]${cut(start, end - w, 'body')}`,
    `[b]${cut(end - w, end, 'tail')}`,
    `[c]${cut(start - w, start, 'head')}`,
    `[tail][head]xfade=transition=fade:duration=${TAIL_SEC}:offset=0[seam]`,
    '[body][seam]concat=n=2:v=1:a=0,fps=30,format=yuv420p,split=2[m][v]',
  ].join(';');
  await run(ffmpeg, [
    '-hide_banner', '-y', '-i', source, '-filter_complex', graph,
    '-map', '[m]', '-an', '-c:v', ENCODE.codec, '-crf', String(ENCODE.crf), '-preset', ENCODE.preset,
    '-pix_fmt', ENCODE.pix_fmt, '-r', String(FPS), '-movflags', ENCODE.movflags, mp4,
    '-map', '[v]', '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '4',
    '-row-mt', '1', '-pix_fmt', 'yuv420p', '-r', String(FPS), webm,
  ]);
}

export async function main(argv, { load = loadScenes } = {}) {
  const logger = createLogger();
  try {
    const { values } = parseArgs({
      args: argv,
      options: { scenes: { type: 'string' }, capture: { type: 'string' }, out: { type: 'string' } },
    });
    if (!values.scenes || !values.capture || !values.out) throw new UsageError(USAGE);

    // Checked on the raw file first: a template-only document would otherwise fail the footage-share rule
    // with a message that has nothing to do with the loop.
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(values.scenes, 'utf8'));
    } catch {
      raw = null; // loadScenes reports an unreadable or malformed file
    }
    if (Array.isArray(raw?.scenes) && !raw.scenes.some((s) => s?.type === 'footage')) {
      throw new UsageError(`no footage scenes in ${values.scenes}; the hero loop is built from footage`);
    }

    const flowDurations = readCaptureDurations(values.capture);
    const doc = await load(values.scenes, { flowDurations });
    const footage = doc.scenes.filter((s) => s.type === 'footage');
    if (footage.length === 0) throw new UsageError(`no footage scenes in ${values.scenes}; the hero loop is built from footage`);
    assertFootageFiles(doc.scenes, values.capture);
    const { ffmpeg } = await requireFfmpeg();

    const outDir = path.resolve(values.out);
    const workDir = path.join(outDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    const source = path.join(workDir, 'source.mkv');
    await buildSource({ ffmpeg, scenes: footage, captureDir: values.capture, outFile: source });
    const diffs = await sourceDiffs({ ffmpeg, source, rawFile: path.join(workDir, 'diffs.gray') });

    const { start, end, score } = pickLoopPoints(diffs, FPS, { tailSec: TAIL_SEC });
    const mp4 = path.join(outDir, 'hero-loop.mp4');
    const webm = path.join(outDir, 'hero-loop.webm');
    await renderLoop({ ffmpeg, source, start, end, mp4, webm });
    fs.rmSync(workDir, { recursive: true, force: true });
    logger.info(`hero loop: frames ${start}-${end} (${((end - start) / FPS).toFixed(2)} s, seam score ${score.toFixed(4)}) -> ${mp4}, ${webm}`);
    return 0;
  } catch (e) {
    logger.error(e instanceof ValidationError ? `invalid scenes:\n${e.message}` : e.message);
    return e instanceof FfmpegUnavailableError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
