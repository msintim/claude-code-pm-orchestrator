import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  MOVE_MS,
  PAUSE_MS,
  HOLD_MS,
  easeOutCubic,
  mulberry32,
  cursorPath,
  typingDelays,
  CURSOR_INIT_SCRIPT,
} from '../lib/cursor.js';

test('timing constants', () => {
  assert.deepEqual([MOVE_MS, PAUSE_MS, HOLD_MS], [400, 150, 600]);
});

test('easeOutCubic', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(0.5), 0.875);
});

test('cursorPath eases, lands on target, spans 400 ms at 60 fps', () => {
  const p = cursorPath({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(p.at(-1), { x: 100, y: 0, t: 400 });
  assert.ok(p.length >= 24 && p.length <= 26);
  assert.ok(p.find((q) => q.t >= 200).x > 50); // ease-out: past halfway at half time
  assert.ok(p.every((q, i) => i === 0 || q.x >= p[i - 1].x));
});

test('cursorPath honours durationMs and fps options', () => {
  const p = cursorPath({ x: 10, y: 20 }, { x: 10, y: 80 }, { durationMs: 200, fps: 30 });
  assert.deepEqual(p.at(-1), { x: 10, y: 80, t: 200 });
  assert.ok(p.length >= 6 && p.length <= 8);
  assert.equal(p[0].t, 0);
});

test('typingDelays within 40..110 ms with mean 60..90 and are seed-deterministic', () => {
  const d = typingDelays('x'.repeat(2000), mulberry32(1));
  assert.ok(d.every((v) => v >= 40 && v <= 110));
  const m = d.reduce((a, b) => a + b) / d.length;
  assert.ok(m >= 60 && m <= 90);
  assert.equal(typingDelays('abc', mulberry32(7)).length, 3);
  assert.deepEqual(typingDelays('abc', mulberry32(7)), typingDelays('abc', mulberry32(7)));
});

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('in-page cursor follows moveTo and ripple disappears', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.addInitScript(CURSOR_INIT_SCRIPT);
    await page.goto('data:text/html,<body style="margin:0"><h1>hi</h1></body>');

    await page.evaluate(() => window.__promoCursor.moveTo(100, 100));
    const box = await page.locator('#__promo-cursor').boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - 100) <= 2);
    assert.ok(Math.abs(box.y + box.height / 2 - 100) <= 2);

    await page.evaluate(() => window.__promoCursor.click(100, 100));
    assert.equal(await page.locator('.__promo-ripple').count(), 1);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.__promo-ripple').count(), 0);
  } finally {
    await browser.close();
  }
});
