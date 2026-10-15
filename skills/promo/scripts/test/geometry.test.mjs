import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padToRatio, clampToFrame, cropForRatio, safeBand, captionRect } from '../lib/geometry.js';

const approx1 = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const approx = (a, b) => { for (const k of ['x', 'y', 'w', 'h']) approx1(a[k], b[k]); };

const S = { w: 1920, h: 1080 }, F = { x: 420, y: 180, w: 1080, h: 720 };

test('16:9 pads horizontally', () => approx(cropForRatio(F, S, { w: 1920, h: 1080 }).rect, { x: 320, y: 180, w: 1280, h: 720 }));
test('1:1 pads vertically', () => approx(cropForRatio(F, S, { w: 1080, h: 1080 }).rect, { x: 420, y: 0, w: 1080, h: 1080 }));
test('9:16 clamps to full height and reports 0.5625 coverage', () => {
  const r = cropForRatio(F, S, { w: 1080, h: 1920 });
  approx(r.rect, { x: 656.25, y: 0, w: 607.5, h: 1080 });
  approx1(r.coverage, 0.5625);
  assert.equal(r.centered, false);
});
test('focus near the right edge is shifted inside, not stretched', () => {
  approx(cropForRatio({ x: 1500, y: 0, w: 400, h: 300 }, S, { w: 1920, h: 1080 }).rect, { x: 960, y: 0, w: 960, h: 540 });
});
test('tiny focus is padded outward: crop.w >= target.w / 2 (never upscales capture pixels)', () => {
  const r = cropForRatio({ x: 900, y: 500, w: 40, h: 30 }, S, { w: 1920, h: 1080 });
  assert.ok(r.rect.w >= 960 - 0.01);
  approx1(r.rect.w / r.rect.h, 16 / 9);
  approx1(r.coverage, 1);
  const o = cropForRatio({ x: 900, y: 500, w: 40, h: 30 }, S, { w: 1080, h: 1080 }, { sourceScale: 1 });
  assert.ok(o.rect.w >= 1080 - 0.01);
});
test('null focus centre-crops: 9:16', () => {
  const r = cropForRatio(null, S, { w: 1080, h: 1920 });
  approx(r.rect, { x: 656.25, y: 0, w: 607.5, h: 1080 });
  assert.equal(r.coverage, 1);
  assert.equal(r.centered, true);
});
test('padToRatio and clampToFrame', () => {
  approx(padToRatio({ x: 0, y: 0, w: 100, h: 100 }, 2), { x: -50, y: 0, w: 200, h: 100 });
  approx(padToRatio({ x: 0, y: 0, w: 100, h: 100 }, 0.5), { x: 0, y: -50, w: 100, h: 200 });
  approx(clampToFrame({ x: -10, y: 95, w: 20, h: 10 }, { w: 100, h: 100 }), { x: 0, y: 90, w: 20, h: 10 });
  approx(clampToFrame({ x: 0, y: 0, w: 200, h: 100 }, { w: 100, h: 100 }), { x: 0, y: 25, w: 100, h: 50 });
});
test('safeBand', () => {
  assert.deepEqual(safeBand({ w: 1080, h: 1920 }), { top: 250, bottom: 340 });
  assert.deepEqual(safeBand({ w: 1920, h: 1080 }), { top: 0, bottom: 0 });
  assert.deepEqual(safeBand({ w: 540, h: 960 }), { top: 125, bottom: 170 });
});
test('captionRect at 1080x1920 lies within y 250..1580', () => {
  const c = captionRect({ w: 1080, h: 1920 });
  assert.ok(c.y >= 250 && c.y + c.h <= 1580);
});
test('captionRect on 16:9 keeps an 8% bottom margin', () => {
  const c = captionRect({ w: 1920, h: 1080 });
  approx1(c.y + c.h, 1080 * 0.92);
  assert.ok(c.x >= 0 && c.x + c.w <= 1920);
});
