import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpeg, parseCapabilities, run, ffprobeJson } from '../lib/ffmpeg.js';
import {
  frameDurations,
  medianFps,
  buildConcatList,
  buildWebmArgs,
  assembleWebm,
  startFrameCapture,
} from '../lib/screencast.js';

const r3 = (n) => Math.round(n * 1000) / 1000;

// Synchronous so it can feed the `skip` option below.
function resolveFullFfmpegSync() {
  try {
    const bins = resolveFfmpeg();
    const out = (args) => spawnSync(bins.ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).stdout ?? '';
    return parseCapabilities(out(['-encoders']), out(['-filters'])).ok ? bins : null;
  } catch {
    return null;
  }
}
const fullFfmpeg = resolveFullFfmpegSync();

test('frameDurations', () => {
  assert.deepEqual(frameDurations([{ t: 0 }, { t: 0.1 }, { t: 0.35 }], 0.5).map(r3), [0.1, 0.25, 0.15]);
  assert.deepEqual(frameDurations([], 1), []);
});

test('medianFps of evenly spaced 30 fps frames is 30', () => {
  const frames = Array.from({ length: 31 }, (_, i) => ({ t: i / 30 }));
  assert.equal(medianFps(frames), 30);
});

test('medianFps ignores a single long stall', () => {
  const frames = [0, 0.1, 0.2, 0.3, 5].map((t) => ({ t }));
  assert.equal(medianFps(frames), 10);
});

test('medianFps with fewer than two frames is 0', () => {
  assert.equal(medianFps([]), 0);
  assert.equal(medianFps([{ t: 0 }]), 0);
});

test('buildConcatList gives per-frame durations and repeats the last file', () => {
  const frames = [
    { file: 'C:\\tmp\\a b\\f1.jpg', t: 0 },
    { file: 'C:\\tmp\\a b\\f2.jpg', t: 0.5 },
    { file: "C:\\tmp\\it's\\f3.jpg", t: 1.0 },
  ];
  const lines = buildConcatList(frames, 1.5).split('\n').filter(Boolean);
  assert.equal(lines[0], 'ffconcat version 1.0');
  assert.deepEqual(lines.slice(1), [
    "file 'C:/tmp/a b/f1.jpg'",
    'duration 0.5',
    "file 'C:/tmp/a b/f2.jpg'",
    'duration 0.5',
    "file 'C:/tmp/it'\\''s/f3.jpg'",
    'duration 0.5',
    "file 'C:/tmp/it'\\''s/f3.jpg'",
  ]);
});

test('buildWebmArgs encodes 60 fps CFR VP9 via the concat demuxer', () => {
  const args = buildWebmArgs({ list: 'l.txt', out: 'o.webm' });
  const has = (...seq) => args.join(' ').includes(seq.join(' '));
  assert.ok(has('-f', 'concat', '-safe', '0', '-i', 'l.txt'));
  assert.ok(args.includes('fps=60'));
  assert.ok(has('-c:v', 'libvpx-vp9'));
  assert.ok(has('-crf', '12'));
  assert.ok(has('-b:v', '0'));
  assert.ok(has('-pix_fmt', 'yuv420p'));
  assert.equal(args.at(-1), 'o.webm');
  assert.ok(buildWebmArgs({ list: 'l', out: 'o', fps: 30, crf: 20 }).includes('fps=30'));
});

test('startFrameCapture writes frames, timestamps on a Node clock, and awaits writes on stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-sc-'));
  let onFrame;
  let stopped = false;
  const page = {
    screencast: {
      start: async (o) => {
        onFrame = o.onFrame;
        assert.deepEqual(o.size, { width: 8, height: 8 });
        assert.equal(o.quality, 90);
        return { dispose: async () => {} };
      },
      stop: async () => {
        stopped = true;
      },
    },
  };
  try {
    const cap = await startFrameCapture(page, { dir, size: { width: 8, height: 8 }, quality: 90 });
    assert.equal(cap.nowT(), 0);
    onFrame({ data: Buffer.from('a'), timestamp: 999, viewportWidth: 8, viewportHeight: 8 });
    await new Promise((r) => setTimeout(r, 30));
    onFrame({ data: Buffer.from('b'), timestamp: 1000, viewportWidth: 8, viewportHeight: 8 });
    assert.ok(cap.nowT() > 0.02);
    const { frames, endT } = await cap.stop();
    assert.ok(stopped);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].t, 0);
    assert.ok(frames[1].t >= 0.025 && frames[1].t < 1);
    assert.ok(endT >= frames[1].t);
    assert.equal(fs.readFileSync(frames[0].file, 'utf8'), 'a');
    assert.equal(fs.readFileSync(frames[1].file, 'utf8'), 'b');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assembleWebm yields 60 fps CFR VP9 of the right length', { skip: fullFfmpeg === null }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-asm-'));
  try {
    const colors = ['red', 'green', 'blue'];
    const times = [0, 0.5, 1.0];
    const frames = [];
    for (let i = 0; i < 3; i++) {
      const file = path.join(dir, `f${i}.jpg`);
      await run(fullFfmpeg.ffmpeg, [
        '-y', '-f', 'lavfi', '-i', `color=c=${colors[i]}:s=320x180`, '-frames:v', '1', file,
      ]);
      frames.push({ file, t: times[i] });
    }
    const out = path.join(dir, 'out.webm');
    await assembleWebm({ ffmpeg: fullFfmpeg.ffmpeg, frames, endT: 1.5, out });
    const probe = await ffprobeJson(fullFfmpeg.ffprobe, out);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'vp9');
    assert.equal(v.r_frame_rate, '60/1');
    assert.equal(v.pix_fmt, 'yuv420p');
    assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.03);
    // Matroska/WebM carries no frame count in the header, so decode-count it.
    const counted = await run(fullFfmpeg.ffprobe, [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'json', out,
    ]);
    const count = Number(JSON.parse(counted.stdout).streams[0].nb_read_frames);
    assert.ok(Math.abs(count - 90) <= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
