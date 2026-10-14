import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { requireFfmpeg, run, ffprobeJson } from '../lib/ffmpeg.js';
import { tmpDir, runCliAsync, scriptsDir } from './helpers.mjs';

const loop = path.join(scriptsDir, 'loop.mjs');
const FLOW = 'sample';
const SECONDS = 20;

// 30 fps, 20 s. A fast-moving field that freezes for 2 s at [4,6) and [14,16): the quiet stretches the loop
// points should land in.
const PHASE = 'N-min(max(N-120,0),60)-min(max(N-420,0),60)';
const clipSource = `color=c=black:s=64x36:r=30:d=${SECONDS},geq=r='128+127*sin((${PHASE})*0.9+X*0.2)':`
  + `g='128+127*sin((${PHASE})*1.3+Y*0.3)':b='128+127*sin((${PHASE})*0.5+X*0.1+Y*0.1)',scale=1920:1080:flags=bicubic,format=yuv420p`;

const BRAND = { primary: '#0F766E', accent: '#F59E0B', font: 'sans-serif', theme: 'light' };
const FOOTAGE = { type: 'footage', flow: FLOW, in: 0, out: SECONDS, caption: 'Record a payment in one tap', transition: 'cut' };

let bins;
let captureDir;
let scenesFile;
let out;
let result;

const probe = (file) => ffprobeJson(bins.ffprobe, file);

// Raw gray frames at 64x36, for seam and median checks.
async function grayFrames(file) {
  const raw = path.join(path.dirname(file), `${path.basename(file)}.gray`);
  await run(bins.ffmpeg, ['-hide_banner', '-y', '-i', file, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', raw]);
  const buf = fs.readFileSync(raw);
  const size = 64 * 36;
  return Array.from({ length: buf.length / size }, (_, i) => buf.subarray(i * size, (i + 1) * size));
}

const meanAbs = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length / 255;

before(async () => {
  bins = await requireFfmpeg();
  captureDir = tmpDir('loop-capture');
  await run(bins.ffmpeg, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', clipSource,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-deadline', 'realtime', '-cpu-used', '8',
    '-pix_fmt', 'yuv420p', path.join(captureDir, `${FLOW}.webm`),
  ]);
  fs.writeFileSync(path.join(captureDir, 'report.json'), JSON.stringify({
    version: 1, status: 'ok', flows: [{ name: FLOW, video: `${FLOW}.webm`, durationSec: SECONDS }],
  }));
  scenesFile = path.join(tmpDir('loop-scenes'), 'scenes.json');
  fs.writeFileSync(scenesFile, JSON.stringify({
    version: 1, fps: 30, master: { w: 1920, h: 1080 }, brand: BRAND,
    scenes: [
      { type: 'hook', duration: 2.5, text: 'Rent day, without the chasing.', transition: 'cut' },
      FOOTAGE,
      { type: 'outro', duration: 2.5, text: 'RPMS', sub: 'rpms.example', transition: 'none' },
    ],
  }));
  out = tmpDir('loop-out');
  result = await runCliAsync(loop, ['--scenes', scenesFile, '--capture', captureDir, '--out', out]);
  console.log(`loop: exit ${result.status}`);
});

test('outputs: mp4 + webm, 1920x1080, 30 fps, duration 8..15 s, no audio stream', async () => {
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['hero-loop.mp4', 'hero-loop.webm']) {
    const info = await probe(path.join(out, name));
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.width, 1920, name);
    assert.equal(v.height, 1080, name);
    assert.equal(v.avg_frame_rate, '30/1', name);
    assert.equal(info.streams.some((s) => s.codec_type === 'audio'), false, `${name} has an audio stream`);
    const sec = Number(info.format.duration);
    assert.ok(sec >= 8 && sec <= 15, `${name} runs ${sec} s`);
  }
  assert.equal((await probe(path.join(out, 'hero-loop.webm'))).streams[0].codec_name, 'vp9');
});

test('seam: |last frame - first frame| <= 2x the median inter-frame diff of the output', async () => {
  assert.equal(result.status, 0, result.stderr);
  const frames = await grayFrames(path.join(out, 'hero-loop.mp4'));
  const seam = meanAbs(frames.at(-1), frames[0]);
  const steps = frames.slice(1).map((f, i) => meanAbs(f, frames[i])).sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  assert.ok(seam <= 2 * median, `seam ${seam} vs median ${median}`);
});

test('mp4 is faststart: "moov" occurs before "mdat" in the file bytes', () => {
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(path.join(out, 'hero-loop.mp4'));
  const moov = bytes.indexOf('moov');
  const mdat = bytes.indexOf('mdat');
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, `moov at ${moov}, mdat at ${mdat}`);
});

test('no text/captions: loop.mjs ignores scene text fields (scenes with only template scenes -> exit 1 "no footage scenes")', async () => {
  const file = path.join(tmpDir('loop-templates'), 'scenes.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, fps: 30, master: { w: 1920, h: 1080 }, brand: BRAND,
    scenes: [
      { type: 'hook', duration: 2, text: 'Rent day, without the chasing.', transition: 'cut' },
      { type: 'outro', duration: 2, text: 'RPMS', sub: 'rpms.example', transition: 'none' },
    ],
  }));
  const r = await runCliAsync(loop, ['--scenes', file, '--capture', captureDir, '--out', tmpDir('loop-none')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no footage scenes/);
});

test('footage shorter than 8.5 s is a usage error naming the minimum', async () => {
  const file = path.join(tmpDir('loop-short'), 'scenes.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, fps: 30, master: { w: 1920, h: 1080 }, brand: BRAND,
    scenes: [
      { type: 'hook', duration: 4, text: 'Rent day, without the chasing.', transition: 'cut' },
      { ...FOOTAGE, out: 8 },
      { type: 'outro', duration: 4, text: 'RPMS', sub: 'rpms.example', transition: 'none' },
    ],
  }));
  const r = await runCliAsync(loop, ['--scenes', file, '--capture', captureDir, '--out', tmpDir('loop-short-out')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /8\.5/);
});
