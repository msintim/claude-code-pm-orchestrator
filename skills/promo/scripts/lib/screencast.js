import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { run } from './ffmpeg.js';

// Clock: Node-side performance.now() at onFrame arrival, in seconds since the first frame.
// Before the first frame arrives nowT() is 0, so early beat timestamps land on the first frame.
export async function startFrameCapture(page, { dir, size, quality = 90 }) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const pending = [];
  let origin = null;
  let failure = null;

  const nowT = () => (origin === null ? 0 : (performance.now() - origin) / 1000);

  const onFrame = ({ data }) => {
    const now = performance.now();
    origin ??= now;
    const file = path.join(dir, `frame-${String(frames.length + 1).padStart(6, '0')}.jpg`);
    frames.push({ file, t: (now - origin) / 1000 });
    pending.push(fs.promises.writeFile(file, data).catch((e) => { failure ??= e; }));
  };

  await page.screencast.start({ onFrame, size, quality });

  return {
    nowT,
    async stop() {
      await page.screencast.stop();
      await Promise.all(pending);
      if (failure) throw new Error(`failed to write a screencast frame: ${failure.message}`);
      return { frames, endT: nowT() };
    },
  };
}

export function frameDurations(frames, endT) {
  return frames.map((f, i) => (i + 1 < frames.length ? frames[i + 1].t : endT) - f.t);
}

export function medianFps(frames) {
  if (frames.length < 2) return 0;
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? Math.round((1 / median) * 1000) / 1000 : 0;
}

const concatPath = (p) => p.replaceAll('\\', '/').replaceAll("'", "'\\''");

// Concat-demuxer script: each frame is shown for its duration; the last file is repeated because
// the demuxer ignores the final `duration` directive otherwise.
export function buildConcatList(frames, endT) {
  const durations = frameDurations(frames, endT);
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    lines.push(`file '${concatPath(f.file)}'`, `duration ${durations[i]}`);
  });
  if (frames.length) lines.push(`file '${concatPath(frames.at(-1).file)}'`);
  return `${lines.join('\n')}\n`;
}

export function buildWebmArgs({ list, out, fps = 60, crf = 12 }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${fps}`,
    '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p',
    out,
  ];
}

// Re-times the variable-rate frames into constant-fps VP9 webm (Chromium-playable, unlike H.264 builds).
export async function assembleWebm({ ffmpeg, frames, endT, fps = 60, out, crf = 12 }) {
  if (!frames.length) throw new Error('assembleWebm: no frames to assemble');
  const list = `${out}.concat.txt`;
  fs.writeFileSync(list, buildConcatList(frames, endT));
  try {
    await run(ffmpeg, buildWebmArgs({ list, out, fps, crf }));
  } finally {
    fs.rmSync(list, { force: true });
  }
}
