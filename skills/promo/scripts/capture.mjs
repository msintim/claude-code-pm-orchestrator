#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadPromoConfig, stagingOrigin, ValidationError } from './lib/schema.js';
import { CURSOR_INIT_SCRIPT, HOLD_MS, MOVE_MS, PAUSE_MS, cursorPath, mulberry32, typingDelays } from './lib/cursor.js';
import { assembleWebm, medianFps, startFrameCapture } from './lib/screencast.js';
import { FfmpegUnavailableError, ffprobeJson, requireFfmpeg } from './lib/ffmpeg.js';
import { createLogger } from './lib/log.js';
import { CHROMIUM_ARGS, installOriginGate } from './lib/origin-gate.js';
import { PAGE_SCANNER_SCRIPT, PATTERN_SOURCES, createOcr, scanDom } from './lib/pii.js';

export const VIEWPORT = { w: 1920, h: 1080 };
export const DEVICE_SCALE_FACTOR = 2;
export const FPS = 60;
const IDLE_QUIET_MS = 300;
const FIRST_FRAME_WAIT_MS = 5000;

/** Bad invocation (unknown --feature, missing args): exit 1. */
export class UsageError extends Error {}
/** The environment cannot run a capture (browser missing): exit 2. */
export class EnvironmentError extends Error {}

// Best-effort cleanup step: never throws, never waits longer than `ms` (a hung navigation can block these).
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round3 = (n) => Math.round(n * 1000) / 1000;
const beatKind = (beat) => Object.keys(beat)[0];

function seedFromName(name) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hideInitScript(selectors) {
  return `(() => {
  const css = ${JSON.stringify(selectors)}.map((s) => s + '{display:none !important}').join('\\n');
  // An init script can run before <html> exists, so the style may have nowhere to go yet.
  const add = () => {
    if (document.getElementById('__promo-hide')) return true;
    const root = document.head || document.documentElement;
    if (!root) return false;
    const st = document.createElement('style');
    st.id = '__promo-hide';
    st.textContent = css;
    root.appendChild(st);
    return true;
  };
  if (!add()) {
    const mo = new MutationObserver(() => { if (add()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
  document.addEventListener('DOMContentLoaded', add);
})();`;
}

// Copies hits the in-page scanner found into the Node side (the page's own array dies with the document).
const PII_RELAY = `(() => {
  setInterval(() => {
    const h = window.__promoPiiHits;
    if (h && h.length && window.__promoPiiReport) Promise.resolve(window.__promoPiiReport(h.splice(0))).catch(() => {});
  }, 50);
})();`;

// Failures that must not leave extra screenshots behind: the offending still already exists, or the page holds credentials.
const NO_FAILURE_SHOT = new Set(['pii', 'login', 'hide']);
const GATE_KINDS = new Set(['origin', 'pii', 'login', 'hide']);

// report.json and stderr are shared artifacts: they name what was found (kind, frame) without repeating the value.
export const maskMatch = (m) => { const s = String(m); return s.length ? `${Array.from(s)[0]}***` : '***'; };

/** A beat that could not run: carries what report.failed needs. */
class FlowFailure extends Error {
  constructor({ flow, beatIndex, kind, message }) {
    super(message);
    this.flow = flow;
    this.beatIndex = beatIndex;
    this.kind = kind;
    this.screenshot = null;
  }
}

// Logs in inside a throwaway context: the login page is never recorded and only the resulting session
// (cookies/localStorage, in memory) reaches the recorded context. The password goes into the page and nowhere else.
async function performLogin({ browser, flow, config, origin, env, beatTimeout, scrub, blocked }) {
  const { login } = config.staging;
  const gate = { violation: null, blocked, flow: flow.name, beat: null };
  // serviceWorkers 'block': requests a worker makes or answers bypass context.route, so a staging PWA could leave the origin unseen.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let page;
  try {
    await installOriginGate(context, { origin, gate, mainPage: () => page });
    page = await context.newPage();
    const failure = (kind, message) => new FlowFailure({ flow: flow.name, beatIndex: null, kind, message });
    const blocked = () => failure('origin', `flow ${flow.name} login: blocked navigation to ${gate.violation.origin}`);
    try {
      await page.goto(new URL(login.path, config.staging.url).href, { waitUntil: 'load', timeout: beatTimeout });
      await page.locator('input[type=password]').first().fill(env[login.pass_env], { timeout: beatTimeout });
      await page.locator('input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])')
        .first().fill(env[login.user_env], { timeout: beatTimeout });
      await page.locator(login.submit).first().click({ timeout: beatTimeout });
      await page.locator(login.settled).first().waitFor({ state: 'visible', timeout: beatTimeout });
    } catch (e) {
      if (gate.violation) throw blocked();
      const first = String(e.message).split(/\r?\n/)[0];
      throw failure('login', scrub(`flow "${flow.name}" login failed (${login.settled} not reached; wrong credentials?): ${first}`));
    }
    if (gate.violation) throw blocked();
    return await context.storageState();
  } finally {
    await within(context.close(), 5000);
  }
}

// Anything a beat throws that is not already a FlowFailure: an actionability timeout is a selector
// problem (covered, disabled, detached); everything else (navigation timeout, HTTP/network error) is 'navigation'.
function classifyBeatError(e, flow, beatIndex, beat, beatTimeout) {
  const kind = beatKind(beat);
  const sel = selectorOf(beat);
  const first = String(e.message).split(/\r?\n/)[0];
  if (e.name === 'TimeoutError' && sel && kind !== 'goto') {
    return new FlowFailure({
      flow, beatIndex, kind: 'selector',
      message: `flow "${flow}" beat ${beatIndex} (${kind}): selector "${sel}" could not be acted on within ${beatTimeout} ms: ${first}`,
    });
  }
  return new FlowFailure({
    flow, beatIndex, kind: 'navigation',
    message: `flow "${flow}" beat ${beatIndex} (${kind}) failed: ${first}`,
  });
}

function selectorOf(beat) {
  const v = beat[beatKind(beat)];
  return typeof v === 'string' ? v : v?.selector;
}

async function runFlow({ browser, flow, config, origin, outDir, bins, env, logger, hooks, tally, ocr, pii, blocked, scrub }) {
  const beatTimeout = Number(env.PROMO_BEAT_TIMEOUT_MS ?? 10000);
  const idleTimeout = Number(env.PROMO_IDLE_TIMEOUT_MS ?? 10000);
  const hide = config.hide ?? [];
  const redact = config.redact ?? [];
  const frameDir = path.join(outDir, `.frames-${flow.name}`);
  const storageState = config.staging.login ? await performLogin({ browser, flow, config, origin, env, beatTimeout, scrub, blocked }) : undefined;
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.w, height: VIEWPORT.h },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'no-preference',
    serviceWorkers: 'block', // see performLogin: workers bypass the origin gate
    // The hide and cursor styles are injected by script; a staging style-src CSP would silently drop them.
    bypassCSP: true,
    storageState,
  });
  let cap;
  try {
    let page;
    const gate = { violation: null, blocked, flow: flow.name, beat: null };
    const pending = []; // PII the in-page scanner saw on screen between settles
    const frameLabel = () => `${flow.name}@${round3(cap?.nowT() ?? 0)}s`;
    await installOriginGate(context, { origin, gate, mainPage: () => page });
    await context.exposeFunction('__promoPiiReport', (hits) => {
      const frame = frameLabel();
      for (const h of hits) pending.push({ frame, kind: h.kind, match: h.match, source: 'dom' });
    });
    await context.addInitScript(CURSOR_INIT_SCRIPT);
    await context.addInitScript(PAGE_SCANNER_SCRIPT(PATTERN_SOURCES, redact));
    await context.addInitScript(PII_RELAY);
    if (hide.length) await context.addInitScript(hideInitScript(hide));
    page = await context.newPage();
    // A renderer that dies or is closed mid-flow loses relayed hits and the unscanned tail: that is a gate failure, not a quiet end.
    let pageGone = null;
    page.on('crash', () => { pageGone ??= 'the page crashed'; });
    page.on('close', () => { pageGone ??= 'the page was closed unexpectedly'; });

    const visited = [];
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        const u = new URL(frame.url());
        if ((u.protocol === 'http:' || u.protocol === 'https:') && visited.at(-1) !== u.pathname) visited.push(u.pathname);
      } catch { /* about:blank and friends */ }
    });

    const originFailure = (index) => new FlowFailure({
      flow: flow.name, beatIndex: index, kind: 'origin',
      message: `flow ${flow.name} beat ${index}: blocked navigation to ${gate.violation.origin}`,
    });
    // Hits found on a still, plus any transient ones queued so far, fail the run; every one is kept in report.pii.
    const piiFailure = (index, found) => {
      const all = [...found, ...pending.splice(0)].map((h) => ({ ...h, match: maskMatch(h.match) }));
      pii.hits.push(...all);
      const h = all[0];
      return new FlowFailure({
        flow: flow.name, beatIndex: index, kind: 'pii',
        message: `PII gate: ${h.frame} contains ${h.kind} "${h.match}" (${h.source})`,
      });
    };
    const goneFailure = (index) => new FlowFailure({
      flow: flow.name, beatIndex: index, kind: 'pii',
      message: `PII gate: ${pageGone} in flow ${flow.name}, so what was on screen could not be verified`,
    });
    const checkGates = (index) => {
      if (gate.violation) throw originFailure(index);
      if (pending.length) throw piiFailure(index, []);
      if (pageGone) throw goneFailure(index);
    };
    // The relay polls every 50 ms; this picks up whatever it has not shipped yet.
    const drainPage = async () => {
      // Mid-navigation the document (and its array) is gone and the next page's relay takes over; a dead page is not that.
      const hits = await page.evaluate(() => window.__promoPiiHits?.splice(0) ?? []).catch((e) => {
        if (pageGone || page.isClosed()) throw e;
        return [];
      });
      const frame = frameLabel();
      for (const h of hits) pending.push({ frame, kind: h.kind, match: h.match, source: 'dom' });
    };

    // Network activity, for the idle wait and the third-party tally.
    const inflight = new Set();
    let lastActivity = performance.now();
    context.on('request', (req) => {
      inflight.add(req);
      lastActivity = performance.now();
      try {
        const u = new URL(req.url());
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin) {
          tally.set(u.origin, (tally.get(u.origin) ?? 0) + 1);
        }
      } catch { /* not a URL we can classify */ }
    });
    const done = (req) => {
      inflight.delete(req);
      lastActivity = performance.now();
    };
    context.on('requestfinished', done);
    context.on('requestfailed', done);

    cap = await startFrameCapture(page, {
      dir: frameDir,
      size: { width: VIEWPORT.w * DEVICE_SCALE_FACTOR, height: VIEWPORT.h * DEVICE_SCALE_FACTOR },
      quality: 90,
    });
    // Frames are rebased to the first one and nowT() is 0 until it arrives: stamping a beat earlier would land at t=0.
    const waitStart = performance.now();
    while (cap.nowT() === 0 && performance.now() - waitStart < FIRST_FRAME_WAIT_MS) await sleep(20);
    if (cap.nowT() === 0) throw new EnvironmentError('the browser delivered no screencast frames');

    const hidden = Object.fromEntries(hide.map((s) => [s, 0]));
    // Counts matches per hide selector and proves each one really is display:none (a CSP, an inline !important or
    // a late style can defeat the injected rule); any visible match means the redaction failed, so the flow fails closed.
    const checkHidden = async (index) => {
      if (!hide.length) return;
      const res = await page.evaluate((sels) => sels.map((s) => {
        try {
          const els = Array.from(document.querySelectorAll(s));
          return { n: els.length, visible: els.filter((el) => getComputedStyle(el).display !== 'none').length };
        } catch { return { n: 0, visible: 0, invalid: true }; }
      }), hide);
      const broken = res.findIndex((r) => r.invalid);
      if (broken >= 0) {
        throw new FlowFailure({
          flow: flow.name, beatIndex: index, kind: 'hide',
          message: `hide gate: flow "${flow.name}" beat ${index}: hide selector "${hide[broken]}" is not a valid CSS selector, so it cannot be verified as hidden`,
        });
      }
      res.forEach(({ n }, i) => { hidden[hide[i]] = Math.max(hidden[hide[i]], n); });
      const bad = res.findIndex((r) => r.visible > 0);
      if (bad >= 0) {
        throw new FlowFailure({
          flow: flow.name, beatIndex: index, kind: 'hide',
          message: `hide gate: flow "${flow.name}" beat ${index}: ${res[bad].visible} element(s) matching hide selector "${hide[bad]}" are still visible`,
        });
      }
    };

    const cursor = { pos: null };
    const restoreCursor = async () => {
      if (!cursor.pos) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: beatTimeout });
          await page.evaluate(([x, y]) => window.__promoCursor.moveTo(x, y), [cursor.pos.x, cursor.pos.y]);
          return;
        } catch { await sleep(100); }
      }
    };
    const glide = async (to) => {
      const from = cursor.pos ?? { x: VIEWPORT.w / 2, y: VIEWPORT.h / 2 };
      const start = performance.now();
      for (const p of cursorPath(from, to, { durationMs: MOVE_MS, fps: FPS })) {
        const wait = p.t - (performance.now() - start);
        if (wait > 0) await sleep(wait);
        await page.evaluate(([x, y]) => window.__promoCursor.moveTo(x, y), [p.x, p.y]);
      }
      await page.mouse.move(to.x, to.y);
      cursor.pos = to;
    };
    const ripple = ({ x, y }) => page.evaluate(([cx, cy]) => window.__promoCursor.click(cx, cy), [x, y]);
    const waitIdle = async () => {
      const start = performance.now();
      lastActivity = Math.max(lastActivity, start);
      while (performance.now() - start < idleTimeout) {
        if (inflight.size === 0 && performance.now() - lastActivity >= IDLE_QUIET_MS) return true;
        await sleep(50);
      }
      return false;
    };

    const beats = [];
    const settles = [];
    let settleCount = 0;

    // Playwright's scrollIntoViewIfNeeded scrolls instantly, which the recording shows as a jump cut.
    // This keeps the browser's own choice of where to scroll and animates the way there. In one task
    // (so nothing is painted in between) it lets Chromium scroll instantly, notes where every scroller
    // ended up, puts them back, then smooth-scrolls each one to its noted position. A scroll beat always
    // centres its target (top edge if taller than the window); other beats move only if Chromium's
    // if-needed rule says so, so an in-view target never moves the page.
    const smoothIntoView = async (loc, always) => {
      const run = loc.evaluate(async (el, { force, capMs }) => {
        // Every scroller el's position depends on: composed ancestors across shadow roots and same-origin frames.
        const ancestors = [];
        for (let n = el, doc = el.ownerDocument; n;) {
          const up = n.assignedSlot ?? n.parentElement ?? n.parentNode?.host;
          if (up) {
            ancestors.push(up);
            n = up;
          } else {
            n = doc.defaultView?.frameElement ?? null; // null across origins
            if (n) doc = n.ownerDocument;
          }
        }
        const scrollers = ancestors.filter((s) => s.scrollHeight > s.clientHeight || s.scrollWidth > s.clientWidth);
        const pos = () => scrollers.map((s) => [s.scrollLeft, s.scrollTop]);
        const from = pos();
        // CSS scroll-behavior: smooth would make the browser's own scroll animate, so turn it off meanwhile.
        const smoothCss = scrollers.filter((s) => getComputedStyle(s).scrollBehavior === 'smooth');
        const saved = smoothCss.map((s) => [s.style.getPropertyValue('scroll-behavior'), s.style.getPropertyPriority('scroll-behavior')]);
        for (const s of smoothCss) s.style.setProperty('scroll-behavior', 'auto', 'important');
        const tall = el.getBoundingClientRect().height > innerHeight;
        if (force) {
          el.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest' });
        } else {
          el.scrollIntoViewIfNeeded(true);
          // Chromium centres a fully off-screen target even when it is taller than the window, hiding its top.
          if (tall && pos().join() !== from.join()) el.scrollIntoView({ block: 'start', inline: 'nearest' });
        }
        const to = pos();
        scrollers.forEach((s, i) => { s.scrollLeft = from[i][0]; s.scrollTop = from[i][1]; });
        smoothCss.forEach((s, i) => s.style.setProperty('scroll-behavior', ...saved[i]));
        const moving = scrollers.filter((s, i) => to[i][0] !== from[i][0] || to[i][1] !== from[i][1]);
        if (!moving.length) return;
        scrollers.forEach((s, i) => {
          if (moving.includes(s)) s.scrollTo({ left: to[i][0], top: to[i][1], behavior: 'smooth' });
        });
        // The next animation frame, or 100 ms if frames stop, so a throttled renderer cannot hang the beat.
        const frame = () => new Promise((resolve) => { requestAnimationFrame(resolve); setTimeout(resolve, 100); });
        const start = performance.now();
        let last = pos().join();
        let still = 0;
        while (still < 6 && performance.now() - start < capMs) {
          await frame();
          const now = pos().join();
          still = now === last ? still + 1 : 0;
          last = now;
        }
      }, { force: always, capMs: Math.min(4000, beatTimeout) });
      // evaluate's own timeout covers only finding the element, not running the function: bound it here.
      run.catch(() => {}); // a late rejection after the timeout below has won must not go unhandled
      let timer;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`scroll did not finish within ${beatTimeout} ms`), { name: 'TimeoutError' })), beatTimeout);
      });
      try {
        await Promise.race([run, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    const target = async (sel, index, kind) => {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: beatTimeout });
        await smoothIntoView(loc, kind === 'scroll');
      } catch (e) {
        if (e.name !== 'TimeoutError') throw e;
        throw new FlowFailure({
          flow: flow.name, beatIndex: index, kind: 'selector',
          message: `flow "${flow.name}" beat ${index} (${kind}): selector "${sel}" not found or not visible within ${beatTimeout} ms`,
        });
      }
      const box = await loc.boundingBox();
      if (!box) {
        throw new FlowFailure({
          flow: flow.name, beatIndex: index, kind: 'selector',
          message: `flow "${flow.name}" beat ${index} (${kind}): selector "${sel}" has no bounding box`,
        });
      }
      return { loc, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
    };

    const act = async (beat, index) => {
      const kind = beatKind(beat);
      const value = beat[kind];
      switch (kind) {
        case 'goto': {
          const url = new URL(value, config.staging.url).href;
          await hooks.beforeNavigate?.(url, { flow: flow.name, beatIndex: index });
          await page.goto(url, { waitUntil: 'load', timeout: beatTimeout });
          await checkHidden(index);
          break;
        }
        case 'click': {
          const { loc, center } = await target(value, index, kind);
          await glide(center);
          await sleep(PAUSE_MS);
          await ripple(center);
          await loc.click({ timeout: beatTimeout });
          break;
        }
        case 'fill': {
          const { loc, center } = await target(value.selector, index, kind);
          await glide(center);
          await sleep(PAUSE_MS);
          await ripple(center);
          await loc.click({ timeout: beatTimeout });
          await loc.fill('', { timeout: beatTimeout });
          const delays = typingDelays(value.text, mulberry32(seedFromName(flow.name)));
          const chars = Array.from(value.text);
          for (let i = 0; i < chars.length; i++) {
            await page.keyboard.type(chars[i]);
            await sleep(delays[i]);
          }
          break;
        }
        case 'select': {
          const { loc, center } = await target(value.selector, index, kind);
          await glide(center);
          await sleep(PAUSE_MS);
          await ripple(center);
          await loc.selectOption(value.value, { timeout: beatTimeout });
          break;
        }
        case 'hover': {
          const { center } = await target(value, index, kind);
          await glide(center);
          await sleep(PAUSE_MS);
          break;
        }
        case 'scroll':
          await target(value, index, kind); // target() does the smooth scroll and waits for it to finish
          break;
        case 'wait':
          await sleep(value);
          break;
        case 'settle': {
          await target(value, index, kind);
          const n = ++settleCount;
          const still = `${flow.name}-${n}.png`;
          await hooks.beforeSettle?.({ flow: flow.name, beatIndex: index, selector: value, page });
          await checkHidden(index); // before the still: a redaction that did not take must not reach a kept file
          await page.screenshot({ path: path.join(outDir, still) });
          settles.push({ index, still, t: round3(cap.nowT()) });
          pii.scanned++;
          const domHits = await scanDom(page, { redact });
          if (domHits.length) throw piiFailure(index, domHits.map((h) => ({ frame: still, ...h, source: 'dom' })));
          break;
        }
        default:
          throw new Error(`unsupported beat kind "${kind}"`);
      }
      return kind;
    };

    for (let index = 0; index < flow.beats.length; index++) {
      const beat = flow.beats[index];
      const t0 = cap.nowT();
      gate.beat = index;
      let kind;
      const fail = async (e) => {
        if (e instanceof EnvironmentError) return e;
        let failure;
        if (e instanceof FlowFailure) failure = e;
        else if (gate.violation) failure = originFailure(index); // the blocked request is what surfaced as this error
        else if (pageGone) failure = goneFailure(index);
        else failure = classifyBeatError(e, flow.name, index, beat, beatTimeout);
        if (NO_FAILURE_SHOT.has(failure.kind)) return failure;
        const shot = `failure-${flow.name}-beat${index}.png`;
        // A hung navigation blocks screenshots; cancel it first (the shot is then blank, but still marks the failure), and never wait long on a failure artifact.
        if (failure.kind === 'navigation') await within(page.goto('about:blank', { timeout: 2000 }), 3000);
        await page.screenshot({ path: path.join(outDir, shot), timeout: 5000 }).then(() => { failure.screenshot = shot; }, () => {});
        return failure;
      };
      try {
        kind = await act(beat, index);
        checkGates(index);
      } catch (e) {
        throw await fail(e);
      }
      await restoreCursor();
      await hooks.afterAction?.({ flow: flow.name, beatIndex: index, page });
      const networkIdle = await waitIdle();
      await restoreCursor(); // a navigation that began late (click) is caught here, still before the hold
      await sleep(HOLD_MS);
      try {
        await drainPage();
        checkGates(index);
      } catch (e) {
        throw await fail(e);
      }
      beats.push({ index, kind, t0: round3(t0), t1: round3(cap.nowT()), networkIdle });
    }

    // Nothing checks the page after the last beat's own check, so look once more: before the recording stops
    // and again after OCR (seconds later, with the scanner still running), before any footage is assembled.
    const finalCheck = async () => {
      const last = flow.beats.length - 1;
      try {
        await drainPage();
        const live = await scanDom(page, { redact });
        const frame = frameLabel();
        for (const h of live) pending.push({ frame, ...h, source: 'dom' });
      } catch (e) {
        // An unverified tail is not a clean one: fail closed, no footage.
        if (pageGone) throw goneFailure(last);
        throw new FlowFailure({
          flow: flow.name, beatIndex: last, kind: 'pii',
          message: `PII gate: the final check could not run (${String(e.message).split(/\r?\n/)[0]})`,
        });
      }
      checkGates(last);
    };
    await hooks.beforeFinalCheck?.({ flow: flow.name, page });
    await finalCheck();
    const { frames } = await cap.stop();
    // OCR runs after recording so it cannot stretch a beat; a hit means the footage is never assembled.
    for (const s of settles) {
      const hits = await ocr.scan(path.join(outDir, s.still), { redact });
      if (hits.length) throw piiFailure(s.index, hits.map((h) => ({ frame: s.still, ...h, source: 'ocr' })));
    }
    await finalCheck();
    const endT = beats.at(-1).t1;
    const video = `${flow.name}.webm`;
    const out = path.join(outDir, video);
    await assembleWebm({ ffmpeg: bins.ffmpeg, frames, endT, fps: FPS, out });
    logger.info(`captured ${flow.name}: ${frames.length} frames, ${endT}s`);
    return {
      name: flow.name,
      feature: flow.feature,
      video,
      durationSec: endT,
      screencast: { frames: frames.length, medianFps: medianFps(frames) },
      hidden,
      visited,
      beats,
      settles,
    };
  } finally {
    await within(cap?.stop(), 5000); // idempotent on success; on failure lets pending frame writes finish
    await within(context.close(), 5000);
    try { fs.rmSync(frameDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* never mask the original error */ }
  }
}

export async function runCapture({ configPath, outDir, feature, env = process.env, logger = createLogger(), hooks = {} }) {
  const config = await loadPromoConfig(configPath); // pii_policy is required by the schema: no policy, no run
  const origin = stagingOrigin(config.staging.url);
  const flows = feature ? config.flows.filter((f) => f.feature === feature) : config.flows;
  if (feature && flows.length === 0) {
    const known = [...new Set(config.flows.map((f) => f.feature).filter(Boolean))];
    throw new UsageError(`unknown feature "${feature}"; features in ${configPath}: ${known.join(', ') || '(none)'}`);
  }
  // Credentials are checked (by variable name only) before anything is created or launched.
  const login = config.staging.login;
  if (login) {
    const missing = [login.user_env, login.pass_env].filter((name) => !env[name]);
    if (missing.length) throw new UsageError(`staging.login needs environment variable(s) ${missing.join(', ')} to be set and non-empty`);
  }
  const secretScrub = createLogger({ secrets: login ? [env[login.pass_env]] : [] }).scrub;
  const scrub = (s) => secretScrub(logger.scrub?.(s) ?? s);
  let bins;
  try {
    bins = await requireFfmpeg();
  } catch (e) {
    if (e instanceof FfmpegUnavailableError) throw new EnvironmentError(e.message);
    throw e;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const report = {
    version: 1,
    status: 'ok',
    product: config.product,
    stagingOrigin: origin,
    piiPolicy: config.pii_policy,
    source: {
      viewport: { ...VIEWPORT },
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      fps: FPS,
      videoSize: { w: VIEWPORT.w, h: VIEWPORT.h },
    },
    thirdPartyRequests: [],
    blockedNavigations: [], // popups the browser refused; no request was sent, so they do not fail the run
    flows: [],
    pii: { scanned: 0, hits: [] },
  };
  const tally = new Map();

  let browser;
  let ocr;
  try {
    try {
      ocr = await createOcr();
    } catch (e) {
      throw new EnvironmentError(`cannot start OCR: ${e.message.split('\n')[0]}`);
    }
    try {
      browser = await chromium.launch({ args: CHROMIUM_ARGS });
    } catch (e) {
      throw new EnvironmentError(`cannot launch Chromium: ${e.message.split('\n')[0]} (run: npx playwright install chromium)`);
    }
    // hide: takes CSS. A Playwright-only selector (:has-text, text=) is dropped by the browser's style rule and
    // throws in querySelectorAll, so it would redact nothing; reject it before any staging page is opened.
    const hideList = config.hide ?? [];
    if (hideList.length) {
      const probe = await browser.newPage();
      try {
        const invalid = await probe.evaluate((sels) => sels.filter((s) => {
          try { document.createDocumentFragment().querySelector(s); return false; } catch { return true; }
        }), hideList);
        if (invalid.length) {
          throw new UsageError(invalid.map((s) => `hide selector "${s}" is not a valid CSS selector (hide: takes CSS, not Playwright selectors)`).join('\n'));
        }
      } finally {
        await within(probe.close(), 5000);
      }
    }
    for (const flow of flows) {
      let result;
      try {
        result = await runFlow({ browser, flow, config, origin, outDir, bins, env, logger, hooks, tally, ocr, pii: report.pii, blocked: report.blockedNavigations, scrub });
      } catch (e) {
        if (!(e instanceof FlowFailure)) throw e;
        report.status = 'failed';
        report.failed = { flow: e.flow, beatIndex: e.beatIndex, kind: e.kind, message: scrub(e.message), ...(e.screenshot && { screenshot: e.screenshot }) };
        if (GATE_KINDS.has(e.kind)) {
          // A gated run ships no footage: drop every video this run assembled. report.json and the offending still stay.
          for (const f of report.flows) fs.rmSync(path.join(outDir, f.video), { force: true });
          report.flows = report.flows.map(({ video, ...rest }) => rest);
        }
        break;
      }
      const entry = result;
      if (report.flows.length === 0) {
        const probe = await ffprobeJson(bins.ffprobe, path.join(outDir, entry.video));
        const v = probe.streams.find((s) => s.codec_type === 'video');
        report.source.videoSize = { w: v.width, h: v.height };
      }
      report.flows.push(entry);
    }
  } catch (e) {
    if (e instanceof Error) e.message = scrub(e.message); // a Playwright message may quote what it was typing
    throw e;
  } finally {
    await browser?.close().catch(() => {});
    await ocr?.close().catch(() => {});
  }
  report.thirdPartyRequests = [...tally].map(([o, count]) => ({ origin: o, count })).sort((a, b) => b.count - a.count);
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const EXIT_BY_KIND = { selector: 3, navigation: 3 };

async function main(argv) {
  const logger = createLogger();
  try {
    const { values } = parseArgs({
      args: argv,
      options: { config: { type: 'string' }, out: { type: 'string' }, feature: { type: 'string' } },
    });
    if (!values.config || !values.out) throw new UsageError('usage: capture.mjs --config <promo.yaml> --out <dir> [--feature <tag>]');
    const report = await runCapture({ configPath: values.config, outDir: values.out, feature: values.feature, logger });
    if (report.status === 'failed') {
      logger.error(`capture failed: ${report.failed.message}`);
      return EXIT_BY_KIND[report.failed.kind] ?? 1;
    }
    logger.info(`capture ok: ${report.flows.length} flow(s) -> ${values.out}`);
    return 0;
  } catch (e) {
    logger.error(e instanceof ValidationError ? `invalid config:
${e.message}` : e.message);
    return e instanceof EnvironmentError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
