import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameDiffs, pickLoopPoints, NoLoopError } from '../lib/loop-points.js';

const FPS = 30;

// 600 frames at 30 fps: diff 0.5 everywhere except two quiet windows at 0.01.
const series = Array.from({ length: 600 }, (_, i) => ((i >= 40 && i < 100) || (i >= 350 && i < 420) ? 0.01 : 0.5));
const flatSeries = new Array(600).fill(0.1);

test('picks start and end inside the quiet windows within 8..15 s', () => {
  const r = pickLoopPoints(series, FPS);
  assert.ok(r.start >= 40 && r.start <= 85, `start ${r.start}`);
  assert.ok(r.end >= 365 && r.end <= 420, `end ${r.end}`);
  const sec = (r.end - r.start) / FPS;
  assert.ok(sec >= 8 && sec <= 15, `length ${sec} s`);
  assert.ok(r.score < 0.02, `score ${r.score}`);
});

test('deterministic: same input, same answer', () => {
  assert.deepEqual(pickLoopPoints(series, FPS), pickLoopPoints([...series], FPS));
});

test('ties resolve to the earliest start, then the longest length', () => {
  const r = pickLoopPoints(flatSeries, FPS);
  assert.equal(r.start, 15);
  assert.equal(r.end - r.start, 15 * FPS);
});

test('start leaves room for the 500 ms head crossfade', () => {
  assert.ok(pickLoopPoints(flatSeries, FPS).start >= 15);
});

test('options override the length range and the tail', () => {
  const r = pickLoopPoints(flatSeries, FPS, { minSec: 2, maxSec: 3, tailSec: 1 });
  assert.equal(r.start, 30);
  assert.equal(r.end - r.start, 90);
});

test('throws NoLoopError when footage is shorter than 8.5 s', () => {
  assert.throws(() => pickLoopPoints(new Array(200).fill(0.1), FPS), NoLoopError);
});

test('frameDiffs: identical frames -> 0, inverted frames -> 1', () => {
  const a = new Uint8Array(64).fill(10);
  const inverted = new Uint8Array(64).fill(255);
  const black = new Uint8Array(64).fill(0);
  assert.deepEqual(frameDiffs([a, a.slice(), a.slice()]), [0, 0, 0]);
  assert.deepEqual(frameDiffs([black, inverted, black]), [0, 1, 1]);
  assert.deepEqual(frameDiffs([]), []);
});
