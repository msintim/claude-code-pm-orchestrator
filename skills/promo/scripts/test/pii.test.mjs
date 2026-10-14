import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  PATTERN_SOURCES, PAGE_SCANNER_SCRIPT, TESSDATA_DIR,
  normalizeText, scanText, scanDom, createOcr,
} from '../lib/pii.js';

const positives = [
  ['Contact jane.doe@example.com today', 'email'],
  ['jane.doe @example.com', 'email'], // OCR-style spacing
  ['+233 24 123 4567', 'phone'], ['024 123 4567', 'phone'], ['0241234567', 'phone'],
  ['+44 20 7946 0958', 'phone'], ['+1 (415) 555-0132', 'phone'],
  ['GB82 WEST 1234 5698 7654 32', 'iban'],
  ['4111 1111 1111 1111', 'card'], ['4111-1111-1111-1111', 'card'],
];
const nearMisses = ['2026-10-14', '1920x1080', 'v1.2.3', '12:30:45', 'GHS 1,250.00', '1,234,567.89',
  '60 fps at 2x', '@handle', 'Order #10024', '14 Oct 2026 10:30', 'meet @ noon', 'Ref 2026101414'];

for (const [text, kind] of positives) {
  test(`scanText flags ${kind}: ${text}`, () => {
    assert.ok(scanText(text).some((h) => h.kind === kind), JSON.stringify(scanText(text)));
  });
}
for (const text of nearMisses) {
  test(`scanText ignores near miss: ${text}`, () => {
    assert.deepEqual(scanText(text), []);
  });
}

test('normalizeText collapses whitespace and only joins around @ for email-like neighbours', () => {
  assert.equal(normalizeText('a   b\n c'), 'a b c');
  assert.equal(normalizeText('jane.doe @ example.com'), 'jane.doe@example.com');
  assert.equal(normalizeText('meet @ noon'), 'meet @ noon');
});

test('redact is case-insensitive and reports kind redact', () => {
  assert.deepEqual(scanText('paid by mr SINTIM', { redact: ['Sintim'] }).map((h) => h.kind), ['redact']);
});

test('PATTERN_SOURCES is serialisable and every pattern compiles', () => {
  const round = JSON.parse(JSON.stringify(PATTERN_SOURCES));
  assert.deepEqual(round, PATTERN_SOURCES);
  for (const p of round) new RegExp(p.source, p.flags);
  assert.equal(typeof PAGE_SCANNER_SCRIPT, 'function');
});

let browser;
let tmp;
before(async () => {
  browser = await chromium.launch();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-pii-'));
});
after(async () => {
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scanDom ignores display:none text but sees tiny visible text', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<body><div style="display:none">a@b.co</div><p>hello</p></body>');
    assert.deepEqual(await scanDom(page), []);
    await page.setContent('<body style="background:#fff"><span style="font-size:3px;color:#fefefe">jane@example.com</span></body>');
    const hits = await scanDom(page);
    assert.ok(hits.some((h) => h.kind === 'email'));
  } finally {
    await page.close();
  }
});

test('scanDom reads typed input values and placeholders', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<body><input id="a" placeholder="you@example.com"><input id="b"></body>');
    const hits = await scanDom(page);
    assert.ok(hits.some((h) => h.kind === 'email'), 'placeholder');
    await page.setContent('<body><input id="b"></body>');
    assert.deepEqual(await scanDom(page), []);
    await page.fill('#b', '0241234567');
    assert.ok((await scanDom(page)).some((h) => h.kind === 'phone'), 'typed value');
  } finally {
    await page.close();
  }
});

test('scanDom honours redact strings', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<body>Welcome Kwame Mensah</body>');
    const hits = await scanDom(page, { redact: ['kwame mensah'] });
    assert.deepEqual(hits.map((h) => h.kind), ['redact']);
  } finally {
    await page.close();
  }
});

test('the init script records hits as the page changes', async () => {
  const ctx = await browser.newContext();
  try {
    await ctx.addInitScript({ content: PAGE_SCANNER_SCRIPT(PATTERN_SOURCES, []) });
    const page = await ctx.newPage();
    await page.setContent('<body>nothing</body>');
    await page.evaluate(() => { document.body.textContent = 'ping jane@example.com'; });
    await page.waitForFunction(() => (window.__promoPiiHits || []).length > 0, null, { timeout: 3000 });
    const hits = await page.evaluate(() => window.__promoPiiHits);
    assert.equal(hits[0].kind, 'email');
  } finally {
    await ctx.close();
  }
});

async function shot(html, scale, file) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 800, height: 200 } });
  const page = await ctx.newPage();
  await page.setContent(html);
  const p = path.join(tmp, file);
  await page.screenshot({ path: p });
  await ctx.close();
  return p;
}

test('OCR finds an email rendered at 24px and at 14px with deviceScaleFactor 2', async () => {
  const ocr = await createOcr();
  try {
    const big = await shot('<body style="margin:20px;font:24px Arial;background:#fff;color:#000">Contact jane.doe@example.com now</body>', 1, 'big.png');
    const small = await shot('<body style="margin:20px;font:14px Arial;background:#fff;color:#000">Contact jane.doe@example.com now</body>', 2, 'small.png');
    assert.ok((await ocr.scan(big)).some((h) => h.kind === 'email'), '24px');
    assert.ok((await ocr.scan(small)).some((h) => h.kind === 'email'), '14px @2x');
    const red = await ocr.scan(big, { redact: ['contact'] });
    assert.ok(red.some((h) => h.kind === 'redact'));
  } finally {
    await ocr.close();
  }
});

test('OCR returns [] for a blank page', async () => {
  const ocr = await createOcr();
  try {
    const blank = await shot('<body style="background:#fff"></body>', 1, 'blank.png');
    assert.deepEqual(await ocr.scan(blank), []);
  } finally {
    await ocr.close();
  }
});

test('createOcr rejects (no download) when langPath has no eng.traineddata', async () => {
  await assert.rejects(createOcr({ langPath: path.join(tmp, 'nope') }), /eng\.traineddata/);
});

test('createOcr writes nothing into the vendored directory or cwd', async () => {
  const before = fs.readdirSync(TESSDATA_DIR).sort();
  const cwdBefore = fs.readdirSync(process.cwd()).sort();
  const ocr = await createOcr();
  await ocr.close();
  assert.deepEqual(fs.readdirSync(TESSDATA_DIR).sort(), before);
  assert.deepEqual(fs.readdirSync(process.cwd()).sort(), cwdBefore);
});
