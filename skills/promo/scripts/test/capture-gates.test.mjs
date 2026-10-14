import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpeg, parseCapabilities } from '../lib/ffmpeg.js';
import { serveDirs } from '../lib/server.js';
import { runCapture } from '../capture.mjs';
import { fixtureSite, runCli, runCliAsync, tmpDir, scriptsDir } from './helpers.mjs';

const { equal, deepEqual, ok, match } = assert;
const captureScript = path.join(scriptsDir, 'capture.mjs');

function resolveFullFfmpegSync() {
  try {
    const bins = resolveFfmpeg();
    const out = (args) => spawnSync(bins.ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).stdout ?? '';
    return parseCapabilities(out(['-encoders']), out(['-filters'])).ok ? bins : null;
  } catch {
    return null;
  }
}
const skip = resolveFullFfmpegSync() === null ? 'no full ffmpeg resolved (set PROMO_FFMPEG)' : false;

let site;
let other;
before(async () => {
  other = { requestCount: 0 };
  other.server = http.createServer((req, res) => {
    other.requestCount++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>other origin</body></html>');
  });
  await new Promise((r) => other.server.listen(0, '127.0.0.1', r));
  other.origin = `http://127.0.0.1:${other.server.address().port}`;
  const redirectTo = (to) => (req, res) => { res.writeHead(302, { location: to(req) }); res.end(); };
  const param = (req) => new URL(req.url, 'http://x').searchParams.get('to');
  site = await serveDirs([{ prefix: '/', root: fixtureSite }], {
    handlers: {
      '/redirect': redirectTo(param),
      '/hop': redirectTo((req) => `/redirect?to=${encodeURIComponent(param(req))}`),
      '/old': redirectTo(() => '/sub/landing.html'),
      '/cookie-hop': (req, res) => { res.writeHead(302, { location: '/sub/landing.html', 'set-cookie': 'hopc=1; Path=/' }); res.end(); },
    },
  });
});
after(async () => {
  await site?.close();
  await new Promise((r) => { other.server.closeAllConnections(); other.server.close(r); });
});

const emptyBrowsers = () => tmpDir('no-browsers');

// promo.yaml as JSON (valid YAML): the gate tests build configs from scratch.
function writeConfig({ beats, login, hide, redact, pii = 'demo-tenant-only', flow = 'gate-flow', origin = site.origin }) {
  const cfg = {
    version: 1,
    product: 'Gates',
    brand: { primary: '#0F766E', accent: '#F59E0B', font: 'Inter', theme: 'light' },
    staging: { url: origin, ...(login && { login }) },
    ...(hide && { hide }),
    ...(pii !== null && { pii_policy: pii }),
    ...(redact && { redact }),
    flows: [{ name: flow, beats }],
  };
  const file = path.join(tmpDir('config'), 'promo.yaml');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

async function runGate(opts, env = {}) {
  const outDir = path.join(tmpDir('out'), 'run');
  const cfg = writeConfig(opts);
  const r = await runCliAsync(captureScript, ['--config', cfg, '--out', outDir], { PROMO_BEAT_TIMEOUT_MS: '4000', ...env });
  const reportFile = path.join(outDir, 'report.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  return { r, report, outDir };
}

const webms = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.webm'));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('gate 2: missing pii_policy exits 1 before the browser opens', () => {
  // An empty browsers dir: if a launch were attempted the failure would be exit 2, not 1.
  const outDir = path.join(tmpDir('out'), 'never');
  const cfg = writeConfig({ beats: [{ goto: '/index.html' }], pii: null });
  const r = runCli(captureScript, ['--config', cfg, '--out', outDir], { PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers() });
  equal(r.status, 1);
  match(r.stderr, /\/pii_policy/);
  ok(!fs.existsSync(outDir));
});

const ext = (to) => `/external-link.html?to=${encodeURIComponent(to)}`;
const originCases = {
  goto: (to) => [{ goto: to }],
  'click-link': (to) => [{ goto: ext(to) }, { click: '#out' }],
  'redirect-302': (to) => [{ goto: `/redirect?to=${encodeURIComponent(to)}` }],
  'redirect-302-chain': (to) => [{ goto: `/hop?to=${encodeURIComponent(to)}` }],
  'popup-target-blank': (to) => [{ goto: ext(to) }, { click: '#pop' }],
  'js-location': (to) => [{ goto: ext(to) }, { click: '#js' }],
};
for (const [via, beatsFor] of Object.entries(originCases)) {
  test(`gate 1: ${via} to another origin aborts the flow before any request is sent`, { skip }, async () => {
    const before = other.requestCount;
    const { r, report, outDir } = await runGate({ flow: 'origin-flow', beats: beatsFor(`${other.origin}/landed`) });
    equal(r.status, 1, r.stderr);
    match(r.stderr, /blocked navigation to http:\/\/127\.0\.0\.1:\d+/);
    equal(other.requestCount - before, 0);
    equal(report.status, 'failed');
    equal(report.failed.kind, 'origin');
    equal(report.failed.flow, 'origin-flow');
    ok(!fs.existsSync(path.join(outDir, 'origin-flow.webm')));
    equal(webms(outDir).length, 0);
  });
}

test('gate 1: a popup that bypasses the page-level rewrite is refused, sends no request and is reported', { skip }, async () => {
  const before = other.requestCount;
  const target = `${other.origin}/landed`;
  const { r, report } = await runGate({
    flow: 'origin-flow',
    beats: [{ goto: ext(target) }, { click: '#bypass' }, { wait: 500 }, { settle: 'h1' }],
  });
  equal(other.requestCount - before, 0, 'the popup request must never reach the other origin');
  equal(r.status, 0, r.stderr); // nothing was sent, so the flow is not failed
  deepEqual(report.blockedNavigations, [{ flow: 'origin-flow', beat: 1, url: target, kind: 'popup' }]);
});

test('gate 1: a cross-origin iframe aborts the flow before any request is sent', { skip }, async () => {
  const before = other.requestCount;
  const { r, report, outDir } = await runGate({
    flow: 'origin-flow', beats: [{ goto: `/embed.html?to=${encodeURIComponent(`${other.origin}/widget`)}` }, { wait: 500 }],
  });
  equal(r.status, 1, r.stderr);
  match(r.stderr, /blocked navigation to http:\/\/127\.0\.0\.1:\d+/);
  equal(report.failed.kind, 'origin');
  equal(other.requestCount - before, 0);
  equal(webms(outDir).length, 0);
});

test('redirect: a same-origin 302 lands on its final URL and relative links resolve against it', { skip }, async () => {
  for (const start of ['/old', '/cookie-hop']) {
    const seen = {};
    const hooks = {
      afterAction: async ({ page }) => {
        seen.url = page.url();
        seen.rel = await page.evaluate(() => document.getElementById('rel')?.href);
        seen.cookie = await page.evaluate(() => document.cookie);
      },
    };
    const rep = await runCapture({
      configPath: writeConfig({ flow: 'redir-flow', beats: [{ goto: start }] }),
      outDir: tmpDir('out'), logger: { info() {}, error() {}, scrub: (s) => s }, hooks,
    });
    equal(rep.status, 'ok', start);
    equal(seen.url, `${site.origin}/sub/landing.html`, start);
    equal(seen.rel, `${site.origin}/sub/next.html`, start);
    deepEqual(rep.flows[0].visited, ['/sub/landing.html'], start);
    if (start === '/cookie-hop') ok(seen.cookie.includes('hopc=1'), `cookie from the 302 hop reached the browser: ${seen.cookie}`);
  }
});

test('gate 1: a protocol-relative login path cannot leave the origin (resolved, not prefix-compared)', { skip }, async () => {
  const before = other.requestCount;
  const otherHost = new URL(other.origin).host;
  const { r, report } = await runGate({
    flow: 'origin-flow',
    login: { path: `//${otherHost}/login.html`, user_env: 'RPMS_DEMO_USER', pass_env: 'RPMS_DEMO_PASS', submit: '#submit', settled: '#app-home' },
    beats: [{ goto: '/index.html' }],
  }, { RPMS_DEMO_USER: 'demo', RPMS_DEMO_PASS: 'whatever' });
  equal(r.status, 1, r.stderr);
  equal(report.failed.kind, 'origin');
  equal(other.requestCount - before, 0);
});

test('gate 3: visible email at a settle fails and names the frame', { skip }, async () => {
  const { r, report, outDir } = await runGate({
    flow: 'pii-flow',
    beats: [{ goto: '/pii.html?v=scroll-email' }, { settle: '#ready' }],
  });
  equal(r.status, 1, r.stderr);
  match(r.stderr, /pii-flow-1\.png.*email/);
  equal(report.status, 'failed');
  equal(report.failed.kind, 'pii');
  ok(report.pii.hits.some((h) => h.frame === 'pii-flow-1.png' && h.kind === 'email'));
  ok(fs.existsSync(path.join(outDir, 'pii-flow-1.png')), 'the offending still is kept');
  equal(webms(outDir).length, 0);
});

test('gate 3: email visible for 400 ms between settles is caught by the in-page scanner', { skip }, async () => {
  const { r, report, outDir } = await runGate({
    flow: 'pii-flow',
    beats: [{ goto: '/pii.html?v=transient' }, { wait: 3000 }, { settle: 'h1' }],
  });
  equal(r.status, 1, r.stderr);
  match(r.stderr, /PII gate: pii-flow@[\d.]+s contains email .* \(dom\)/);
  equal(report.failed.kind, 'pii');
  equal(webms(outDir).length, 0);
});

test('gate 3: display:none email is not a hit, 3px near-bg email is a dom hit', { skip }, async () => {
  const hidden = await runGate({ flow: 'pii-flow', beats: [{ goto: '/pii.html?v=hidden' }, { settle: 'h1' }] });
  equal(hidden.r.status, 0, hidden.r.stderr);
  equal(hidden.report.status, 'ok');
  equal(hidden.report.pii.hits.length, 0);
  equal(hidden.report.pii.scanned, 1);

  const near = await runGate({ flow: 'pii-flow', beats: [{ goto: '/pii.html?v=nearbg' }, { settle: 'h1' }] });
  equal(near.r.status, 1, near.r.stderr);
  ok(near.report.pii.hits.some((h) => h.kind === 'email' && h.source === 'dom'));
});

test('gate 3: redact string rendered on page fails (source ocr or dom)', { skip }, async () => {
  const { r, report } = await runGate({
    flow: 'pii-flow', redact: ['Sintim'], beats: [{ goto: '/pii.html?v=redact' }, { settle: 'h1' }],
  });
  equal(r.status, 1, r.stderr);
  ok(report.pii.hits.some((h) => h.kind === 'redact' && ['ocr', 'dom'].includes(h.source)));
});

test('gate 3: OCR hit survives spaced "jane.doe @ example.com" markup', { skip }, async () => {
  // The address lives in a CSS ::after, so only the pixels carry it: DOM text has nothing to find.
  const { r, report } = await runGate({ flow: 'pii-flow', beats: [{ goto: '/pii.html?v=spaced' }, { settle: 'h1' }] });
  equal(r.status, 1, r.stderr);
  match(r.stderr, /pii-flow-1\.png.*email.*\(ocr\)/);
  ok(report.pii.hits.some((h) => h.frame === 'pii-flow-1.png' && h.kind === 'email' && h.source === 'ocr'));
});

test('hide: selector containing the email removes it from both OCR and DOM scans', { skip }, async () => {
  const { r, report } = await runGate({
    flow: 'pii-flow', hide: ['.secret-mail'], beats: [{ goto: '/pii.html?v=secret-mail' }, { settle: 'h1' }],
  });
  equal(r.status, 0, r.stderr);
  equal(report.pii.hits.length, 0);
});

const loginCfg = (path_ = '/login.html') => ({
  path: path_, user_env: 'RPMS_DEMO_USER', pass_env: 'RPMS_DEMO_PASS', submit: '#submit', settled: '#app-home',
});

test('login: missing env var exits 1 naming the variable name, not a value, before the browser opens', () => {
  const outDir = path.join(tmpDir('out'), 'never');
  const cfg = writeConfig({ login: loginCfg(), beats: [{ goto: '/app.html' }] });
  const r = runCli(captureScript, ['--config', cfg, '--out', outDir], {
    PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers(), RPMS_DEMO_USER: 'demo-user-value', RPMS_DEMO_PASS: '',
  });
  equal(r.status, 1);
  match(r.stderr, /RPMS_DEMO_PASS/);
  ok(!r.stderr.includes('demo-user-value'));
  ok(!fs.existsSync(outDir));
});

test('login: password never appears in stdout, stderr, report.json, or any file in outDir', { skip }, async () => {
  const SECRET = 's3cr3t-Value-123'; // the fixture rejects it, so the run ends in kind "login"
  const { r, report, outDir } = await runGate(
    { flow: 'login-flow', login: loginCfg(), beats: [{ goto: '/app.html' }, { settle: '#app-home' }] },
    { RPMS_DEMO_USER: 'demo', RPMS_DEMO_PASS: SECRET },
  );
  equal(r.status, 1, r.stderr);
  equal(report.failed.kind, 'login');
  for (const f of walk(outDir)) if (/\.(json|txt|log)$/.test(f)) ok(!fs.readFileSync(f, 'utf8').includes(SECRET), f);
  ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  equal(webms(outDir).length, 0);
});

test('login: a good login is not recorded and the session carries into the recorded flow', { skip }, async () => {
  const PASS = 'fixture-pass-1';
  const { r, report, outDir } = await runGate(
    { flow: 'login-flow', login: loginCfg(), beats: [{ goto: '/app.html' }, { settle: '#app-home' }] },
    { RPMS_DEMO_USER: 'demo', RPMS_DEMO_PASS: PASS },
  );
  equal(r.status, 0, r.stderr);
  const visited = report.flows[0].visited;
  ok(visited.includes('/app.html'), `visited ${visited}`);
  ok(!visited.includes('/login.html'), `visited ${visited}`);
  for (const f of walk(outDir)) if (/\.(json|txt|log)$/.test(f)) ok(!fs.readFileSync(f, 'utf8').includes(PASS), f);
  ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS));
});
