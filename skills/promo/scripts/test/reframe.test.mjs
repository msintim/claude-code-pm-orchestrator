import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openCompositor, layoutGate } from '../lib/render-core.js';
import { requireFfmpeg, run, ffprobeJson } from '../lib/ffmpeg.js';
import { buildTimeline } from '../lib/timeline.js';
import { checkLayout } from '../lib/layout-check.js';
import { loadScenes } from '../lib/schema.js';
import { main as reframeMain } from '../reframe.mjs';
import { tmpDir, runCliAsync, scriptsDir, writeCapture, writeToneMusicDir } from './helpers.mjs';

const reframe = path.join(scriptsDir, 'reframe.mjs');
const REEL = { w: 1080, h: 1920 };
// The spec's focus sample: 1080x720 at (420,180); at 9:16 the crop keeps 56.25% of it.
const FOCUS = { x: 420, y: 180, w: 1080, h: 720 };

const DOC = {
  version: 1,
  fps: 30,
  master: { w: 1920, h: 1080 },
  brand: { primary: '#0F766E', accent: '#F59E0B', font: 'sans-serif', theme: 'light' },
  music: { track: 'tone', gain_db: -14, duck_db: -6 },
  scenes: [
    { type: 'hook', duration: 2.5, text: 'Rent day, without the chasing.', transition: 'dip-to-brand' },
    { type: 'footage', flow: 'sample', in: 0, out: 8, focus: FOCUS, caption: 'Record a payment in one tap', transition: 'cut' },
    { type: 'feature-callout', duration: 2.5, title: 'Arrears, flagged automatically', body: 'Overdue tenants surface before month end.', transition: 'slide' },
    { type: 'outro', duration: 2.5, text: 'RPMS', sub: 'rpms.example', transition: 'none' },
  ],
};
const TOTAL = buildTimeline(DOC.scenes, 30).total;

let bins;
let captureDir;
let musicDir;
let scenesFile;
let reel; // { out, dir, stills, result }
let square;

const pngSize = (file) => {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

async function runReframe(dir, ratio, extra = []) {
  const out = path.join(dir, `promo-${ratio}.mp4`);
  const t0 = Date.now();
  const result = await runCliAsync(reframe, ['--scenes', scenesFile, '--capture', captureDir, '--ratio', ratio, '--out', out, ...extra]);
  console.log(`reframe ${ratio}: exit ${result.status} in ${Date.now() - t0} ms`);
  return { dir, out, result };
}

before(async () => {
  bins = await requireFfmpeg();
  captureDir = tmpDir('reframe-capture');
  await writeCapture(bins.ffmpeg, captureDir, { flow: 'sample', seconds: 8 });
  musicDir = await writeToneMusicDir(bins.ffmpeg, 2);
  scenesFile = path.join(tmpDir('reframe-scenes'), 'scenes.json');
  fs.writeFileSync(scenesFile, JSON.stringify(DOC));
  const stills = tmpDir('reframe-stills');
  const shared = tmpDir('reframe-out');
  [reel, square] = await Promise.all([
    runReframe(shared, '9x16', ['--music-dir', musicDir, '--stills', stills]),
    runReframe(shared, '1x1', ['--music-dir', musicDir]),
  ]);
  reel.stills = stills;
});

const compositor = [];
after(async () => { await Promise.all(compositor.map((c) => c.close())); });

test('9x16 output is 1080x1920 with duration equal to the master +/- 1 frame and audio duration equal to video +/- 0.05', async () => {
  assert.equal(reel.result.status, 0, reel.result.stderr);
  const probe = await ffprobeJson(bins.ffprobe, reel.out);
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.filter((s) => s.codec_type === 'audio');
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.ok(Math.abs(Number(v.duration) - TOTAL) <= 1 / 30, `video ${v.duration} vs master ${TOTAL}`);
  assert.equal(a.length, 1, 'the music of scenes.json carries over');
  assert.ok(Math.abs(Number(a[0].duration) - Number(v.duration)) <= 0.05, `audio ${a[0].duration} vs video ${v.duration}`);
});

test('1x1 output is 1080x1080', async () => {
  assert.equal(square.result.status, 0, square.result.stderr);
  const v = (await ffprobeJson(bins.ffprobe, square.out)).streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1080, 1080]);
});

test('nothing is letterboxed: ffmpeg cropdetect on a mid frame reports the full frame', async () => {
  const { stderr } = await run(bins.ffmpeg, ['-hide_banner', '-ss', '6', '-i', reel.out, '-frames:v', '3', '-vf', 'cropdetect=limit=24:round=2', '-f', 'null', '-']);
  assert.match(stderr, /crop=1080:1920:0:0/);
  assert.doesNotMatch(stderr, /crop=(?!1080:1920:0:0)\d+:\d+:\d+:\d+/);
});

test('reel template text and captions stay inside y 250..1580 for every scene', async () => {
  const c = await openCompositor({ scenes: DOC.scenes, brand: DOC.brand, size: REEL, captureDir, captionMode: 'reel' });
  compositor.push(c);
  const timeline = buildTimeline(DOC.scenes, 30);
  let fields = 0;
  for (const s of timeline.scenes) {
    await c.drive(s.start + s.duration / 2);
    assert.deepEqual(await checkLayout(c.page, { size: REEL, sceneIndex: s.index }), [], `scene ${s.index + 1}`);
    const rects = await c.page.evaluate(() => [...document.querySelectorAll('[data-field]')]
      .filter((el) => el.getClientRects().length)
      .map((el) => { const r = el.getBoundingClientRect(); return { field: el.dataset.field, top: r.top, bottom: r.bottom }; }));
    for (const r of rects) {
      fields += 1;
      assert.ok(r.top >= 250 - 1 && r.bottom <= 1580 + 1, `scene ${s.index + 1} ${r.field}: ${r.top}..${r.bottom}`);
    }
  }
  assert.equal(fields, 6, `expected hook, caption, callout title+body and outro text+sub to be measured, got ${fields}`);
  const bar = await c.page.evaluate(() => document.querySelector('[data-template="caption-bar"]')?.dataset.captionMode);
  assert.equal(bar, 'reel');
});

test('template scenes are re-rendered natively, not cropped: the 9x16 hook still has its text block width <= 90% of the stage width', async () => {
  const c = await openCompositor({ scenes: DOC.scenes, brand: DOC.brand, size: REEL, captureDir, captionMode: 'reel' });
  compositor.push(c);
  await c.drive(1.25);
  const w = await c.page.evaluate(() => document.querySelector('[data-template="hook"] [data-field="text"]').getBoundingClientRect().width);
  assert.ok(w > 0 && w <= 0.9 * REEL.w, `hook text width ${w}`);
});

test('reframe-report warns with coverage 0.5625 for the spec focus sample at 9x16', () => {
  const report = JSON.parse(fs.readFileSync(path.join(reel.dir, 'reframe-report-9x16.json'), 'utf8'));
  assert.equal(report.ratio, '9x16');
  assert.deepEqual(report.size, REEL);
  assert.deepEqual(report.scenes.map((s) => s.index), [1], 'one entry per footage scene, by scenes.json index');
  assert.ok(Math.abs(report.scenes[0].coverage - 0.5625) < 1e-9, `coverage ${report.scenes[0].coverage}`);
  assert.equal(report.scenes[0].centered, false);
  assert.ok(Math.abs(report.scenes[0].rect.w / report.scenes[0].rect.h - REEL.w / REEL.h) < 1e-9);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /scene 2/);
  assert.match(report.warnings[0], /0\.56/);
});

test('1x1 report has full coverage and no warnings', () => {
  const report = JSON.parse(fs.readFileSync(path.join(square.dir, 'reframe-report-1x1.json'), 'utf8'));
  assert.equal(report.ratio, '1x1');
  assert.deepEqual(report.size, { w: 1080, h: 1080 });
  assert.equal(report.scenes[0].coverage, 1);
  assert.deepEqual(report.warnings, []);
});

test('--stills writes scene/transition stills at 1080x1920 and one contact sheet', () => {
  const names = fs.readdirSync(reel.stills).sort();
  assert.deepEqual(names, [
    'contact-9x16.png',
    'scene-01-mid.png', 'scene-02-mid.png', 'scene-03-mid.png', 'scene-04-mid.png',
    'transition-01-02-mid.png', 'transition-03-04-mid.png',
  ]);
  for (const n of names.filter((f) => f.startsWith('scene-') || f.startsWith('transition-'))) {
    assert.deepEqual(pngSize(path.join(reel.stills, n)), REEL, n);
  }
});

test('overflowing text at 9x16 exits 1 and lists scene + field before any encode', async () => {
  const dir = tmpDir('reframe-overflow');
  const out = path.join(dir, 'promo-9x16.mp4');
  // The schema caps text, so the oversize hook is injected after validation.
  const load = async (file, ctx) => {
    const doc = await loadScenes(file, ctx);
    doc.scenes[0].text = 'Collect every single payment without chasing anyone '.repeat(40);
    return doc;
  };
  let stderr = '';
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let code;
  try {
    code = await reframeMain(['--scenes', scenesFile, '--capture', captureDir, '--ratio', '9x16', '--out', out, '--music-dir', musicDir], { load });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(code, 1);
  assert.match(stderr, /scene 1/);
  assert.match(stderr, /"text"/);
  assert.match(stderr, /overflow|safe-area/);
  assert.equal(fs.existsSync(out), false, 'nothing is encoded');
  assert.equal(fs.existsSync(path.join(dir, 'work-9x16')), false, 'no frames are rendered');
  assert.equal(fs.existsSync(path.join(dir, 'reframe-report-9x16.json')), false);
});

test('layoutGate reports a hook that overflows its template, naming scene and field', async () => {
  const scenes = structuredClone(DOC.scenes);
  scenes[0].text = 'Collect every single payment without chasing anyone '.repeat(40);
  const issues = await layoutGate(scenes, DOC.brand, REEL, { captureDir, captionMode: 'reel' });
  assert.ok(issues.some((i) => i.scene === 0 && i.field === 'text' && i.kind === 'overflow'), JSON.stringify(issues));
  assert.deepEqual(await layoutGate(DOC.scenes, DOC.brand, REEL, { captureDir, captionMode: 'reel' }), []);
});

test('CLI refuses an unknown ratio (exit 1) and a missing flag', async () => {
  const bad = await runCliAsync(reframe, ['--scenes', scenesFile, '--capture', captureDir, '--ratio', '4x3', '--out', path.join(tmpDir('reframe-bad'), 'x.mp4')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /1x1|9x16/);
  const none = await runCliAsync(reframe, ['--scenes', scenesFile]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /usage/);
});

test('both ratios reframed into one dir keep distinct render and reframe reports', () => {
  assert.equal(reel.dir, square.dir);
  const names = fs.readdirSync(reel.dir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(names, ['reframe-report-1x1.json', 'reframe-report-9x16.json', 'render-report-1x1.json', 'render-report-9x16.json']);
  const sizes = ['1x1', '9x16'].map((r) => JSON.parse(fs.readFileSync(path.join(reel.dir, `render-report-${r}.json`), 'utf8')).size);
  assert.deepEqual(sizes, [{ w: 1080, h: 1080 }, REEL]);
});

// 60 characters (the schema maximum) of wide capitals, so it wraps to two lines at every ratio.
const WORST_CAPTION = 'WIDE WORDS MAKE WIDE LINES AND WRAP WIDE WORDS WIDE WIDE WIDE'.slice(0, 60);
test('a worst-case schema-max caption gives no layoutGate issues at 16:9, 1:1 and 9:16', async () => {
  assert.equal(WORST_CAPTION.length, 60);
  const scenes = [{ ...DOC.scenes[1], caption: WORST_CAPTION, transition: 'none' }];
  for (const [size, captionMode] of [[{ w: 1920, h: 1080 }, null], [{ w: 1080, h: 1080 }, 'feed'], [REEL, 'reel']]) {
    assert.deepEqual(await layoutGate(scenes, DOC.brand, size, { captureDir, captionMode }), [], `${size.w}x${size.h}`);
  }
});

test('a two-line caption fits the 1:1 caption bar', async () => {
  const size = { w: 1080, h: 1080 };
  const scenes = [{ ...DOC.scenes[1], caption: WORST_CAPTION.slice(0, 52), transition: 'none' }];
  const c = await openCompositor({ scenes, brand: DOC.brand, size, captureDir, captionMode: 'feed' });
  compositor.push(c);
  await c.drive(1);
  const m = await c.page.evaluate(() => {
    const el = document.querySelector('[data-field="caption"]');
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { lines: Math.round(el.getBoundingClientRect().height / lh), h: el.getBoundingClientRect().height, bar: document.querySelector('[data-template="caption-bar"]').getBoundingClientRect().height };
  });
  assert.equal(m.lines, 2, JSON.stringify(m));
  assert.ok(m.h < m.bar, JSON.stringify(m));
  assert.deepEqual(await checkLayout(c.page, { size, sceneIndex: 0 }), []);
});
