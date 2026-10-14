import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { duckIntervals, envelopeDb, buildAudioFilter } from '../lib/audio.js';
import { buildTimeline } from '../lib/timeline.js';
import { requireFfmpeg, run } from '../lib/ffmpeg.js';
import { tmpDir } from './helpers.mjs';

const approx = (got, want, tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol, `${got} vs ${want}`);

const hook = { type: 'hook', duration: 3, text: 'x', transition: 'none' };
const f1 = { type: 'footage', flow: 'a', in: 0, out: 4, transition: 'none' };
const f2 = { type: 'footage', flow: 'b', in: 0, out: 2, transition: 'none' };
const outro = { type: 'outro', duration: 2, text: 'x', transition: 'none' };

test('duckIntervals merges adjacent footage scenes', () => {
  const scenes = [hook, f1, f2, outro];
  assert.deepEqual(duckIntervals(buildTimeline(scenes, 30), scenes), [{ start: 3, end: 9 }]);
});

test('duckIntervals keeps separated footage scenes apart and is empty without footage', () => {
  const scenes = [f1, hook, f2];
  assert.deepEqual(duckIntervals(buildTimeline(scenes, 30), scenes), [{ start: 0, end: 4 }, { start: 7, end: 9 }]);
  assert.deepEqual(duckIntervals(buildTimeline([hook, outro], 30), [hook, outro]), []);
});

test('envelope ramps rather than steps', () => {
  const iv = [{ start: 5, end: 10 }];
  assert.equal(envelopeDb(4.8, iv, -6), 0);
  approx(envelopeDb(4.925, iv, -6), -3);
  assert.equal(envelopeDb(5, iv, -6), -6);
  assert.equal(envelopeDb(10, iv, -6), -6);
  approx(envelopeDb(10.075, iv, -6), -3);
  assert.equal(envelopeDb(10.15, iv, -6), 0);
  assert.equal(envelopeDb(7, [], -6), 0);
});

test('filter ends with a 300 ms fade-out at total - 0.3', () => {
  assert.match(buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [], total: 19.5 }), /afade=t=out:st=19\.2:d=0\.3/);
});

test('filter carries the gain and a frame-evaluated duck envelope only when there is footage', () => {
  const ducked = buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [{ start: 5, end: 10 }], total: 20 });
  assert.match(ducked, /^volume=-14dB,volume='.+':eval=frame,afade=/);
  const plain = buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [], total: 20 });
  assert.doesNotMatch(plain, /eval=frame/);
});

let bins;
before(async () => { bins = await requireFfmpeg(); });

async function sine(file, seconds) {
  await run(bins.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=48000`, file]);
}

async function meanVolume(file, from, length) {
  const { stderr } = await run(bins.ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(length), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  assert.ok(m, `no mean_volume in: ${stderr.slice(-300)}`);
  return Number(m[1]);
}

async function mix(src, out, filter, { loop = false, total }) {
  await run(bins.ffmpeg, [
    '-hide_banner', '-y', ...(loop ? ['-stream_loop', '-1'] : []), '-i', src,
    '-filter_complex', `[0:a]${filter}[a]`, '-map', '[a]', '-t', String(total), out,
  ]);
}

test('loudness: -14 dB gain, -6 dB duck in [5,10], faded tail (real ffmpeg on a generated 20 s sine)', async () => {
  const dir = tmpDir('audio-mix');
  const src = path.join(dir, 'sine.wav');
  const out = path.join(dir, 'mixed.wav');
  await sine(src, 20);
  const filter = buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [{ start: 5, end: 10 }], total: 20 });
  await mix(src, out, filter, { total: 20 });
  const source = await meanVolume(src, 1, 3);
  const before = await meanVolume(out, 1, 3);
  const ducked = await meanVolume(out, 6, 3);
  const after = await meanVolume(out, 12, 3);
  const tail = await meanVolume(out, 19.9, 0.1);
  console.log(`volumedetect mean_volume dB: source[1,4]=${source} gained[1,4]=${before} ducked[6,9]=${ducked} after[12,15]=${after} tail[19.9,20]=${tail}`);
  assert.ok(Math.abs(before - (source - 14)) <= 1, `gain: ${before} vs ${source - 14}`);
  assert.ok(Math.abs(ducked - (before - 6)) <= 1, `duck: ${ducked} vs ${before - 6}`);
  assert.ok(Math.abs(after - before) <= 1, `recovery: ${after} vs ${before}`);
  assert.ok(tail <= before - 10, `fade tail: ${tail} vs ${before}`);
});

test('a 2 s track loops to a 20 s output with no gap (segment [3,4] within 1 dB of [0,1])', async () => {
  const dir = tmpDir('audio-loop');
  const src = path.join(dir, 'short.wav');
  const out = path.join(dir, 'looped.wav');
  await sine(src, 2);
  const filter = buildAudioFilter({ gainDb: -14, duckDb: -6, intervals: [], total: 20 });
  await mix(src, out, filter, { loop: true, total: 20 });
  const first = await meanVolume(out, 0, 1);
  const looped = await meanVolume(out, 3, 1);
  const late = await meanVolume(out, 17, 1);
  console.log(`volumedetect mean_volume dB: [0,1]=${first} [3,4]=${looped} [17,18]=${late}`);
  assert.ok(Math.abs(looped - first) <= 1, `${looped} vs ${first}`);
  assert.ok(Math.abs(late - first) <= 1, `${late} vs ${first}`);
});
