import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { requireFfmpeg, run, ffprobeJson } from '../lib/ffmpeg.js';
import { bakePoster, extractFrame, PosterSizeError } from '../lib/poster.js';
import { tmpDir, runCliAsync, scriptsDir } from './helpers.mjs';

const poster = path.join(scriptsDir, 'poster.mjs');
const W = 320;
const H = 180;

let bins;
let dir;
let withAudio;
let silent;
let still;
let wrongStill;

const probe = (file) => ffprobeJson(bins.ffprobe, file);
const stream = (info, type) => info.streams.find((s) => s.codec_type === type);

async function psnr(a, b) {
  const { stderr } = await run(bins.ffmpeg, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']);
  const m = /average:(\S+)/.exec(stderr);
  assert.ok(m, `no psnr in: ${stderr.slice(-300)}`);
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}

// Frame n of a video as a PNG.
async function frameAt(video, n, name) {
  const out = path.join(dir, name);
  await run(bins.ffmpeg, [
    '-hide_banner', '-y', '-i', video, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-fps_mode', 'passthrough', out,
  ]);
  return out;
}

before(async () => {
  bins = await requireFfmpeg();
  dir = tmpDir('poster');
  withAudio = path.join(dir, 'clip.mp4');
  silent = path.join(dir, 'silent.mp4');
  still = path.join(dir, 'still.png');
  wrongStill = path.join(dir, 'wrong.png');
  const video = ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=30:d=3`];
  const encode = ['-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  await run(bins.ffmpeg, [
    '-hide_banner', '-y', ...video, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
    ...encode, '-c:a', 'aac', '-b:a', '128k', '-shortest', withAudio,
  ]);
  await run(bins.ffmpeg, ['-hide_banner', '-y', ...video, ...encode, silent]);
  // A smooth gradient, clearly unlike testsrc2, so "frame 0 is the still" cannot pass by accident.
  // Opaque like a real screenshot: the gradients source emits alpha, which would blend into the video.
  await run(bins.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:d=1:seed=7`, '-frames:v', '1', '-pix_fmt', 'rgb24', still]);
  await run(bins.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'gradients=s=160x90:d=1:seed=7', '-frames:v', '1', '-pix_fmt', 'rgb24', wrongStill]);
});

test('bake keeps duration within one frame and audio start/duration within 20 ms; audio codec copied', async () => {
  const out = path.join(dir, 'baked.mp4');
  const size = await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: withAudio, still, outVideo: out, outJpg: path.join(dir, 'baked.jpg'),
  });
  assert.deepEqual(size, { width: W, height: H });
  const before = await probe(withAudio);
  const after = await probe(out);
  const dv = Math.abs(Number(stream(after, 'video').duration) - Number(stream(before, 'video').duration));
  assert.ok(dv <= 1 / 30 + 1e-6, `video duration moved by ${dv}`);
  const a0 = stream(before, 'audio');
  const a1 = stream(after, 'audio');
  assert.equal(a1.codec_name, a0.codec_name);
  assert.ok(Math.abs(Number(a1.start_time) - Number(a0.start_time)) <= 0.02, `audio start ${a0.start_time} -> ${a1.start_time}`);
  assert.ok(Math.abs(Number(a1.duration) - Number(a0.duration)) <= 0.02, `audio duration ${a0.duration} -> ${a1.duration}`);
  assert.ok(fs.statSync(path.join(dir, 'baked.jpg')).size > 0);
});

test('frame 0 equals the still (PSNR > 40 dB) and frame 5 equals the source frame 5 (PSNR > 35 dB)', async () => {
  const out = path.join(dir, 'frames.mp4');
  await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: withAudio, still, outVideo: out, outJpg: path.join(dir, 'frames.jpg'),
  });
  const f0 = await psnr(await frameAt(out, 0, 'out-0.png'), still);
  const f5 = await psnr(await frameAt(out, 5, 'out-5.png'), await frameAt(withAudio, 5, 'src-5.png'));
  const source0 = await psnr(await frameAt(withAudio, 0, 'src-0.png'), still);
  console.log(`poster PSNR: frame0 vs still ${f0.toFixed(1)} dB, frame5 vs source ${f5.toFixed(1)} dB, source frame0 vs still ${source0.toFixed(1)} dB`);
  assert.ok(f0 > 40, `frame 0 PSNR ${f0}`);
  assert.ok(f5 > 35, `frame 5 PSNR ${f5}`);
  assert.ok(source0 < 25, 'the still must differ from the source frame 0 for this check to mean anything');
});

test('an RGBA still with partial transparency is flattened: frame 0 matches the opaque still (PSNR > 40 dB)', async () => {
  const translucent = path.join(dir, 'translucent.png');
  await run(bins.ffmpeg, [
    '-hide_banner', '-y', '-i', still, '-vf', 'format=rgba,colorchannelmixer=aa=0.5', '-frames:v', '1', '-pix_fmt', 'rgba', translucent,
  ]);
  assert.equal(stream(await probe(translucent), 'video').pix_fmt, 'rgba');
  const out = path.join(dir, 'alpha.mp4');
  await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: withAudio, still: translucent, outVideo: out, outJpg: path.join(dir, 'alpha.jpg'),
  });
  const f0 = await psnr(await frameAt(out, 0, 'alpha-0.png'), still);
  assert.ok(f0 > 40, `frame 0 PSNR ${f0}`);
});

test('output is faststart (moov before mdat)', async () => {
  const out = path.join(dir, 'fast.mp4');
  await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: withAudio, still, outVideo: out, outJpg: path.join(dir, 'fast.jpg'),
  });
  const bytes = fs.readFileSync(out);
  const moov = bytes.indexOf('moov');
  const mdat = bytes.indexOf('mdat');
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, `moov at ${moov}, mdat at ${mdat}`);
});

test('silent video bakes fine (-map "0:a?") and stays silent', async () => {
  const out = path.join(dir, 'silent-baked.mp4');
  await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: silent, still, outVideo: out, outJpg: path.join(dir, 'silent-baked.jpg'),
  });
  const info = await probe(out);
  assert.equal(info.streams.some((s) => s.codec_type === 'audio'), false);
  assert.equal(stream(info, 'video').codec_name, 'h264');
});

test('still of the wrong size throws PosterSizeError naming both sizes', async () => {
  const out = path.join(dir, 'wrong-size.mp4');
  await assert.rejects(
    bakePoster({
      ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: withAudio, still: wrongStill, outVideo: out, outJpg: path.join(dir, 'wrong-size.jpg'),
    }),
    (e) => e instanceof PosterSizeError && e.message.includes('160x90') && e.message.includes(`${W}x${H}`),
  );
  assert.equal(fs.existsSync(out), false);
});

test('in-place bake (out === video) replaces the file atomically', async () => {
  const copy = path.join(dir, 'inplace.mp4');
  fs.copyFileSync(withAudio, copy);
  await bakePoster({
    ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, video: copy, still, outVideo: copy, outJpg: path.join(dir, 'inplace.jpg'),
  });
  assert.ok(await psnr(await frameAt(copy, 0, 'inplace-0.png'), still) > 40, 'frame 0 was not replaced');
  assert.equal(stream(await probe(copy), 'audio').codec_name, 'aac');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('tmp')), [], 'a temp file was left behind');
});

test('extractFrame writes a JPEG of the frame at t', async () => {
  const out = path.join(dir, 'extract.jpg');
  await extractFrame({ ffmpeg: bins.ffmpeg, video: withAudio, t: 1, out });
  const bytes = fs.readFileSync(out);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
  const v = stream(await probe(out), 'video');
  assert.equal(v.width, W);
  assert.equal(v.height, H);
});

test('--no-bake leaves the video byte-identical and writes poster jpg (hero loop frame 0 is not altered)', async () => {
  const copy = path.join(dir, 'hero.mp4');
  fs.copyFileSync(silent, copy);
  const jpg = path.join(dir, 'hero.jpg');
  const r = await runCliAsync(poster, ['--video', copy, '--still', still, '--poster', jpg, '--no-bake']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(silent)), 'the video was modified');
  assert.deepEqual([...fs.readFileSync(jpg).subarray(0, 2)], [0xff, 0xd8]);
});

test('CLI: bakes to --out and writes --poster; a wrong-size still exits 1; missing args exit 1', async () => {
  const out = path.join(dir, 'cli.mp4');
  const jpg = path.join(dir, 'cli.jpg');
  const ok = await runCliAsync(poster, ['--video', withAudio, '--still', still, '--out', out, '--poster', jpg]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.statSync(out).size > 0 && fs.statSync(jpg).size > 0);
  const bad = await runCliAsync(poster, ['--video', withAudio, '--still', wrongStill, '--out', path.join(dir, 'bad.mp4'), '--poster', path.join(dir, 'bad.jpg')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /160x90/);
  const usage = await runCliAsync(poster, ['--video', withAudio]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage/);
});
