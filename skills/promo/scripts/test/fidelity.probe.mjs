// Manual probe (not a test): measures what page.screencast really delivers at DSF 2.
//   PROMO_FFMPEG=<dir> node test/fidelity.probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveDirs } from '../lib/server.js';
import { startFrameCapture, medianFps } from '../lib/screencast.js';
import { CURSOR_INIT_SCRIPT } from '../lib/cursor.js';
import { resolveFfmpeg, ffprobeJson } from '../lib/ffmpeg.js';
import { fixtureSite, tmpDir } from './helpers.mjs';

const dir = tmpDir('probe');
const server = await serveDirs([{ prefix: '/', root: fixtureSite }]);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await context.addInitScript(CURSOR_INIT_SCRIPT);
  const page = await context.newPage();
  const cap = await startFrameCapture(page, { dir, size: { width: 3840, height: 2160 }, quality: 90 });
  const rawStamps = [];
  const t0 = Date.now();
  await page.goto(`${server.origin}/tenants.html`);
  for (let i = 0; i < 10 && cap.nowT() === 0; i++) await page.waitForTimeout(100);
  console.log('first frame after goto at ms', Date.now() - t0, 'nowT', cap.nowT());
  for (let i = 0; i < 60; i++) {
    await page.evaluate(([x, y]) => window.__promoCursor.moveTo(x, y), [200 + i * 20, 300 + i * 5]);
    await page.waitForTimeout(50);
  }
  const { frames, endT } = await cap.stop();
  const first = frames[0].file;
  const bins = resolveFfmpeg();
  const probe = await ffprobeJson(bins.ffprobe, first);
  const v = probe.streams[0];
  console.log(JSON.stringify({
    frames: frames.length, endT, medianFps: medianFps(frames),
    firstFrame: { w: v.width, h: v.height, codec: v.codec_name },
    firstT: frames[0].t, rawStamps,
  }));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
