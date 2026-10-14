import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TEXT_LIMITS, ENTRANCE_SECONDS } from '../lib/schema.js';
import { checkLayout } from '../lib/layout-check.js';
import {
  openCompositor, renderStills, makeContactSheet, assertFontAvailable, FontUnavailableError,
} from '../lib/render-core.js';
import { requireFfmpeg } from '../lib/ffmpeg.js';
import { tmpDir, runCliAsync, scriptsDir } from './helpers.mjs';

const SIZES = [{ w: 1920, h: 1080 }, { w: 1080, h: 1080 }, { w: 1080, h: 1920 }];
const BRAND = { primary: '#1d4ed8', accent: '#f59e0b', font: 'sans-serif', theme: 'light' };
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const SCENES = [
  { type: 'hook', duration: 2.5, text: 'Ship the demo in minutes', transition: 'dip-to-brand' },
  { type: 'title-card', duration: 3, title: 'Meet Promo', sub: 'Launch videos from your staging flows', transition: 'slide' },
  { type: 'feature-callout', duration: 3, title: 'Smart crops', body: 'One recording, three ratios, no re-shoot.', transition: 'cut' },
  { type: 'outro', duration: 3, text: 'Try it today', sub: 'promo.example', transition: 'none' },
];

const worstCase = (limit) => {
  const words = [];
  for (let n = 0; n < limit; n += 9) words.push('W'.repeat(8));
  return words.join(' ').slice(0, limit);
};
const worstScene = (type) => ({
  type, duration: 3, transition: 'none',
  ...Object.fromEntries(Object.entries(TEXT_LIMITS[type]).map(([k, limit]) => [k, worstCase(limit)])),
});

const opened = [];
const open = async (opts) => {
  const c = await openCompositor({ scenes: SCENES, brand: BRAND, size: SIZES[0], ...opts });
  opened.push(c);
  return c;
};
after(async () => { await Promise.all(opened.map((c) => c.close())); });

test('renders a hook at 1920x1080, 1080x1080 and 1080x1920 from the same template', async () => {
  const hashes = new Set();
  for (const size of SIZES) {
    const c = await open({ size });
    await c.drive(1.2);
    const png = await c.shot();
    assert.deepEqual(pngSize(png), size);
    hashes.add(sha(png));
    assert.deepEqual(await checkLayout(c.page, { size, sceneIndex: 0 }), []);
  }
  assert.equal(hashes.size, 3);
});

test('frames are a pure function of t (order independent)', async () => {
  const c = await open();
  await c.drive(1.2);
  const a = sha(await c.shot());
  await c.drive(0.3);
  await c.drive(2.5);
  await c.drive(4.0);
  await c.drive(1.2);
  assert.equal(sha(await c.shot()), a);
  await c.drive(2.5); // mid transition
  const mid = sha(await c.shot());
  await c.drive(7);
  await c.drive(2.5);
  assert.equal(sha(await c.shot()), mid);
});

test('entrance animates: a frame at the start differs from a settled one, and settles by ENTRANCE_SECONDS', async () => {
  const c = await open();
  await c.drive(0.1);
  const early = sha(await c.shot());
  await c.drive(ENTRANCE_SECONDS);
  const settled = sha(await c.shot());
  await c.drive(2);
  assert.notEqual(early, settled);
  assert.equal(sha(await c.shot()), settled);
});

test('transitions: dip-to-brand reaches the brand colour at its midpoint; slide differs from both ends', async () => {
  const c = await open({ size: { w: 480, h: 270 } });
  await c.drive(2.5);
  const px = await c.page.evaluate(() => {
    const el = document.getElementById('dip');
    return { op: getComputedStyle(el).opacity, bg: getComputedStyle(el).backgroundColor };
  });
  assert.equal(px.op, '1');
  assert.equal(px.bg, 'rgb(29, 78, 216)');
  await c.drive(5.5);
  const mid = sha(await c.shot());
  await c.drive(5.3);
  const before = sha(await c.shot());
  await c.drive(5.7);
  const after = sha(await c.shot());
  assert.notEqual(mid, before);
  assert.notEqual(mid, after);
});

test('field text is set via textContent: markup in text renders as text', async () => {
  const text = '<img src=x onerror=window.pwn=1>';
  const c = await open({ scenes: [{ type: 'hook', duration: 3, text, transition: 'none' }] });
  await c.drive(1.2);
  const r = await c.page.evaluate(() => ({
    imgs: document.querySelectorAll('img').length,
    pwn: window.pwn,
    shown: document.querySelector('[data-field="text"]').textContent,
  }));
  assert.equal(r.imgs, 0);
  assert.equal(r.pwn, undefined);
  assert.equal(r.shown, text);
});

test('templates contain no scripts', () => {
  const dir = new URL('../../templates/', import.meta.url);
  for (const f of ['hook', 'title-card', 'feature-callout', 'caption-bar', 'outro']) {
    const html = fs.readFileSync(new URL(`${f}.html`, dir), 'utf8');
    assert.ok(!/<script/i.test(html), f);
    assert.ok(/data-template/.test(html), f);
  }
});

test('base.css entrance duration matches ENTRANCE_SECONDS', () => {
  const css = fs.readFileSync(new URL('../../templates/base.css', import.meta.url), 'utf8');
  assert.ok(css.includes(`--entrance: ${ENTRANCE_SECONDS}s`));
});

test('worst-case max-length text fits every template at all three ratios', async () => {
  for (const size of SIZES) {
    const scenes = ['hook', 'title-card', 'feature-callout', 'outro'].map(worstScene);
    const c = await open({ scenes, size });
    for (let i = 0; i < scenes.length; i += 1) {
      await c.drive(i * 3 + 2);
      const issues = await checkLayout(c.page, { size, sceneIndex: i });
      assert.deepEqual(issues, [], `${scenes[i].type} at ${size.w}x${size.h}`);
    }
    await c.close();
  }
});

test('checkLayout flags an element forced outside the 9:16 safe band', async () => {
  const size = { w: 1080, h: 1920 };
  const c = await open({ size });
  await c.drive(1.2);
  assert.deepEqual(await checkLayout(c.page, { size, sceneIndex: 0 }), []);
  await c.page.evaluate(() => {
    const el = document.querySelector('[data-field="text"]');
    el.style.position = 'absolute';
    el.style.top = '10px';
    el.style.left = '60px';
  });
  const issues = await checkLayout(c.page, { size, sceneIndex: 0 });
  assert.ok(issues.some((i) => i.kind === 'safe-area' && i.field === 'text' && i.scene === 0), JSON.stringify(issues));
});

test('checkLayout flags overflow and an element outside the stage', async () => {
  const size = SIZES[0];
  const c = await open({ size });
  await c.drive(1.2);
  await c.page.evaluate(() => {
    const el = document.querySelector('[data-field="text"]');
    el.style.width = '40px';
    el.style.whiteSpace = 'nowrap';
  });
  assert.ok((await checkLayout(c.page, { size, sceneIndex: 0 })).some((i) => i.kind === 'overflow'));
  await c.page.evaluate(() => {
    const el = document.querySelector('[data-field="text"]');
    el.style.position = 'absolute';
    el.style.left = '1900px';
  });
  assert.ok((await checkLayout(c.page, { size, sceneIndex: 0 })).some((i) => i.kind === 'outside-stage'));
});

test('unknown brand font fails loudly naming the font; generic families pass', async () => {
  const c = await open();
  await assert.rejects(assertFontAvailable(c.page, 'Definitely Not A Font 123'), (e) => {
    assert.ok(e instanceof FontUnavailableError);
    assert.match(e.message, /Definitely Not A Font 123/);
    return true;
  });
  for (const generic of ['serif', 'sans-serif', 'monospace']) await assertFontAvailable(c.page, generic);
  await assert.rejects(
    openCompositor({ scenes: SCENES, brand: { ...BRAND, font: 'Definitely Not A Font 123' }, size: SIZES[0] }),
    /Definitely Not A Font 123/,
  );
});

test('a footage scene renders as a blank placeholder layer until Task 9 composites footage', async () => {
  const footage = { type: 'footage', flow: 'f', in: 0, out: 3, caption: 'c', transition: 'none' };
  const c = await open({ scenes: [footage] });
  await c.drive(1);
  assert.equal(await c.page.evaluate(() => document.querySelectorAll('[data-field]').length), 0);
});

test('renderStills writes one PNG per scene midpoint and per non-cut transition midpoint', async () => {
  const outDir = tmpDir('stills');
  const size = { w: 480, h: 270 };
  const r = await renderStills({ scenes: SCENES, brand: BRAND, size, outDir });
  assert.deepEqual(r.files.map((f) => path.basename(f.file)), [
    'scene-01-mid.png', 'transition-01-02-mid.png', 'scene-02-mid.png',
    'transition-02-03-mid.png', 'scene-03-mid.png', 'scene-04-mid.png',
  ]);
  for (const f of r.files) assert.deepEqual(pngSize(fs.readFileSync(f.file)), size);
  assert.deepEqual(r.layoutIssues, []);
});

test('makeContactSheet writes one image whose width = cols x thumbWidth', async () => {
  const outDir = tmpDir('sheet');
  const { files } = await renderStills({ scenes: SCENES, brand: BRAND, size: { w: 480, h: 270 }, outDir });
  const { ffmpeg } = await requireFfmpeg();
  const out = path.join(outDir, 'sheet.png');
  await makeContactSheet({ ffmpeg, files: files.map((f) => f.file), out, cols: 3, thumbWidth: 200 });
  assert.equal(pngSize(fs.readFileSync(out)).w, 600);
  assert.equal(pngSize(fs.readFileSync(out)).h, Math.ceil(files.length / 3) * 112);
});

test('render.mjs --stills writes stills and a contact sheet from a scenes file', async () => {
  const dir = tmpDir('render-cli');
  const scenesFile = path.join(dir, 'scenes.json');
  const footage = { type: 'footage', flow: 'f', in: 0, out: 10, caption: 'Pay in one click', transition: 'cut' };
  fs.writeFileSync(scenesFile, JSON.stringify({
    version: 1, fps: 30, master: { w: 1920, h: 1080 }, brand: BRAND,
    scenes: [SCENES[0], footage, SCENES[3]],
  }));
  const out = path.join(dir, 'out');
  const r = await runCliAsync(path.join(scriptsDir, 'render.mjs'), ['--scenes', scenesFile, '--capture', dir, '--out', out, '--stills', '--size', '480x270']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), [
    'contact-sheet.png', 'scene-01-mid.png', 'scene-02-mid.png', 'scene-03-mid.png', 'transition-01-02-mid.png',
  ]);
  const bad = await runCliAsync(path.join(scriptsDir, 'render.mjs'), ['--scenes', scenesFile, '--out', out]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--stills/);
});
