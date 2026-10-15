import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

// Fail closed: no Luhn check and no email domain allow-list. A false positive
// costs a retry; a false negative ships a customer's data in a launch video.
export const PATTERN_SOURCES = [
  { kind: 'email', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}', flags: 'g' },
  // Ghana: +233 / 00233 / leading 0, then nine digits with optional single separators.
  { kind: 'phone', source: '(?<![\\w+.])(?:(?:\\+|00)233[\\s-]*(?:\\(0\\))?[\\s-]*|0)\\d(?:[\\s-]?\\d){8}(?!\\d)', flags: 'g' },
  // International: + then 8-15 digits in total, separators allowed.
  { kind: 'phone', source: '(?<![\\w+])\\+\\d(?:[\\s().-]*\\d){7,14}(?!\\d)', flags: 'g' },
  { kind: 'iban', source: '\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\\b', flags: 'g' },
  { kind: 'card', source: '(?<![\\w.])\\d(?:[ -]?\\d){12,18}(?!\\d)', flags: 'g' },
];

// normalizeText and scanWith are self-contained so they can be serialised into
// the page (Function#toString) and share one implementation with Node.
export function normalizeText(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    // OCR often puts a gap beside "@". Rejoin only when the right side is a real
    // domain, so "meet @ noon" is left alone.
    .replace(/([A-Za-z0-9._%+-]+) ?@ ?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, '$1@$2');
}

function scanWith(text, patterns, redact) {
  const norm = normalizeText(text);
  const hits = [];
  const seen = new Set();
  const add = (kind, match) => {
    const key = `${kind}\u0000${match}`;
    if (!seen.has(key)) {
      seen.add(key);
      hits.push({ kind, match });
    }
  };
  for (const p of patterns) {
    for (const m of norm.matchAll(new RegExp(p.source, p.flags))) add(p.kind, m[0]);
  }
  const lower = norm.toLowerCase();
  for (const r of redact || []) {
    const needle = normalizeText(r).toLowerCase();
    if (!needle) continue;
    let i = lower.indexOf(needle);
    while (i !== -1) {
      add('redact', norm.slice(i, i + needle.length));
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  return hits;
}

export function scanText(text, { redact = [] } = {}) {
  return scanWith(text, PATTERN_SOURCES, redact);
}

function buildPageScript(patterns, redact, poll) {
  return `(() => {
  ${normalizeText.toString()}
  ${scanWith.toString()}
  const cfg = { patterns: ${JSON.stringify(patterns)}, redact: ${JSON.stringify(redact || [])} };
  window.__promoPiiCfg = cfg;
  window.__promoPiiHits = window.__promoPiiHits || [];
  const seen = new Set(window.__promoPiiHits.map((h) => h.kind + '\\u0000' + h.match));
  const isShown = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const collect = () => {
    if (!document.body) return '';
    const parts = [document.body.innerText || ''];
    for (const el of document.querySelectorAll('input, textarea')) {
      // A password field renders as bullets, so its value is not on screen.
      if (el.type === 'password' || !isShown(el)) continue;
      parts.push(el.value || '', el.placeholder || '');
    }
    return parts.join('\\n');
  };
  window.__promoPiiScanNow = () => scanWith(collect(), window.__promoPiiCfg.patterns, window.__promoPiiCfg.redact);
  const tick = () => {
    for (const h of window.__promoPiiScanNow()) {
      const key = h.kind + '\\u0000' + h.match;
      if (!seen.has(key)) { seen.add(key); window.__promoPiiHits.push(h); }
    }
  };
  ${poll ? 'if (!window.__promoPiiTimer) window.__promoPiiTimer = setInterval(tick, 100);' : ''}
})();`;
}

/** Init script: every 100 ms scans visible text and pushes new hits into window.__promoPiiHits. */
export function PAGE_SCANNER_SCRIPT(patterns, redact) {
  return buildPageScript(patterns, redact, true);
}

/** Scans what is visible right now (display:none content excluded). Returns current hits only. */
export async function scanDom(page, { redact = [] } = {}) {
  const script = `${buildPageScript(PATTERN_SOURCES, redact, false)}\nwindow.__promoPiiScanNow();`;
  return page.evaluate(script);
}

export const TESSDATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'tessdata');

export async function createOcr({ langPath = TESSDATA_DIR } = {}) {
  // tesseract.js falls back to a CDN download for a missing file only when no
  // langPath is given; the explicit check keeps the failure loud either way.
  if (!fs.existsSync(path.join(langPath, 'eng.traineddata'))) {
    throw new Error(`eng.traineddata not found in ${langPath}; OCR data is vendored and never downloaded`);
  }
  // OEM 1 = LSTM only, matching the 4.0.0_best_int model. 'none' disables cache reads and writes.
  const worker = await createWorker('eng', 1, { langPath, gzip: false, cacheMethod: 'none' });
  return {
    async scan(pngPath, { redact = [] } = {}) {
      const { data } = await worker.recognize(pngPath);
      return scanText(data.text, { redact });
    },
    async close() {
      await worker.terminate();
    },
  };
}
