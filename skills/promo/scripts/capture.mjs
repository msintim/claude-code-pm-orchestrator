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
import { ffprobeJson, requireFfmpeg } from './lib/ffmpeg.js';
import { createLogger } from './lib/log.js';

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
  const add = () => {
    if (document.getElementById('__promo-hide')) return;
    const st = document.createElement('style');
    st.id = '__promo-hide';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  add();
  document.addEventListener('DOMContentLoaded', add);
})();`;
}

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

async function runFlow({ browser, flow, config, origin, outDir, bins, env, logger, hooks, tally }) {
  const beatTimeout = Number(env.PROMO_BEAT_TIMEOUT_MS ?? 10000);
  const idleTimeout = Number(env.PROMO_IDLE_TIMEOUT_MS ?? 10000);
  const hide = config.hide ?? [];
  const frameDir = path.join(outDir, `.frames-${flow.name}`);
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.w, height: VIEWPORT.h },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: 'no-preference',
  });
  let cap;
  try {
    await context.addInitScript(CURSOR_INIT_SCRIPT);
    if (hide.length) await context.addInitScript(hideInitScript(hide));
    const page = await context.newPage();

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
    const countHidden = async () => {
      if (!hide.length) return;
      const counts = await page.evaluate((sels) => sels.map((s) => {
        try { return document.querySelectorAll(s).length; } catch { return 0; }
      }), hide).catch(() => null);
      counts?.forEach((n, i) => { hidden[hide[i]] = Math.max(hidden[hide[i]], n); });
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

    const target = async (sel, index, kind) => {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: beatTimeout });
        await loc.scrollIntoViewIfNeeded({ timeout: beatTimeout });
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
          await countHidden();
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
        case 'scroll': {
          const { loc } = await target(value, index, kind);
          await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          let last = -1;
          for (let i = 0; i < 40; i++) {
            const y = await page.evaluate(() => window.scrollY);
            if (y === last) break;
            last = y;
            await sleep(100);
          }
          break;
        }
        case 'wait':
          await sleep(value);
          break;
        case 'settle': {
          await target(value, index, kind);
          const n = ++settleCount;
          const still = `${flow.name}-${n}.png`;
          await hooks.beforeSettle?.({ flow: flow.name, beatIndex: index, selector: value, page });
          await page.screenshot({ path: path.join(outDir, still) });
          settles.push({ index, still, t: round3(cap.nowT()) });
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
      let kind;
      try {
        kind = await act(beat, index);
      } catch (e) {
        if (e instanceof EnvironmentError) throw e;
        const failure = e instanceof FlowFailure ? e : classifyBeatError(e, flow.name, index, beat, beatTimeout);
        const shot = `failure-${flow.name}-beat${index}.png`;
        // A hung navigation blocks screenshots; cancel it first (the shot is then blank, but still marks the failure), and never wait long on a failure artifact.
        if (failure.kind === 'navigation') await within(page.goto('about:blank', { timeout: 2000 }), 3000);
        await page.screenshot({ path: path.join(outDir, shot), timeout: 5000 }).then(() => { failure.screenshot = shot; }, () => {});
        throw failure;
      }
      await restoreCursor();
      await hooks.afterAction?.({ flow: flow.name, beatIndex: index, page });
      const networkIdle = await waitIdle();
      await restoreCursor(); // a navigation that began late (click) is caught here, still before the hold
      await sleep(HOLD_MS);
      beats.push({ index, kind, t0: round3(t0), t1: round3(cap.nowT()), networkIdle });
    }

    const { frames } = await cap.stop();
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
  const config = await loadPromoConfig(configPath);
  const origin = stagingOrigin(config.staging.url);
  const flows = feature ? config.flows.filter((f) => f.feature === feature) : config.flows;
  if (feature && flows.length === 0) {
    const known = [...new Set(config.flows.map((f) => f.feature).filter(Boolean))];
    throw new UsageError(`unknown feature "${feature}"; features in ${configPath}: ${known.join(', ') || '(none)'}`);
  }
  const bins = await requireFfmpeg();
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
    flows: [],
    pii: { scanned: 0, hits: [] },
  };
  const tally = new Map();

  let browser;
  try {
    try {
      browser = await chromium.launch();
    } catch (e) {
      throw new EnvironmentError(`cannot launch Chromium: ${e.message.split('\n')[0]} (run: npx playwright install chromium)`);
    }
    for (const flow of flows) {
      let result;
      try {
        result = await runFlow({ browser, flow, config, origin, outDir, bins, env, logger, hooks, tally });
      } catch (e) {
        if (!(e instanceof FlowFailure)) throw e;
        report.status = 'failed';
        report.failed = { flow: e.flow, beatIndex: e.beatIndex, kind: e.kind, message: e.message, ...(e.screenshot && { screenshot: e.screenshot }) };
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
  } finally {
    await browser?.close().catch(() => {});
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
