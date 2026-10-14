import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpeg, parseCapabilities, ffprobeJson } from '../lib/ffmpeg.js';
import { serveDirs } from '../lib/server.js';
import { createLogger } from '../lib/log.js';
import { runCapture } from '../capture.mjs';
import { fixtureSite, materializeConfig, runCli, runCliAsync, tmpDir, scriptsDir } from './helpers.mjs';

const { equal, deepEqual, ok, match } = assert;
const captureScript = path.join(scriptsDir, 'capture.mjs');
const template = path.join(fixtureSite, '.promo', 'promo.yaml');
const quiet = { info() {}, error() {}, scrub: (s) => s };

function resolveFullFfmpegSync() {
  try {
    const bins = resolveFfmpeg();
    const out = (args) => spawnSync(bins.ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).stdout ?? '';
    return parseCapabilities(out(['-encoders']), out(['-filters'])).ok ? bins : null;
  } catch {
    return null;
  }
}
const bins = resolveFullFfmpegSync();
const skip = bins === null ? 'no full ffmpeg resolved (set PROMO_FFMPEG)' : false;

let server;
before(async () => {
  server = await serveDirs([{ prefix: '/', root: fixtureSite }]);
});
after(async () => {
  await server?.close();
});

const config = () => materializeConfig(template, { ORIGIN: server.origin, PORT: new URL(server.origin).port });

// Writes a yaml derived from the fixture template with one text replacement.
function configWith(from, to) {
  const text = fs.readFileSync(config(), 'utf8');
  assert.ok(text.includes(from), `template lacks ${from}`);
  const file = path.join(tmpDir('config'), 'promo.yaml');
  fs.writeFileSync(file, text.replace(from, to));
  return file;
}

test('happy path', { skip }, async (t) => {
  const outDir = tmpDir('out');
  const rep = await runCapture({ configPath: config(), outDir, logger: quiet });
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));

  await t.test('writes webm per flow, settle stills and report.json', () => {
    equal(rep.status, 'ok');
    equal(report.version, 1);
    deepEqual(rep.flows.map((f) => f.name), ['tenant-onboarding', 'rent-collection']);
    for (const f of rep.flows) {
      ok(fs.existsSync(path.join(outDir, f.video)));
      ok(f.settles.length >= 1);
    }
    ok(fs.existsSync(path.join(outDir, 'tenant-onboarding-1.png')));
    deepEqual(rep.source.viewport, { w: 1920, h: 1080 });
    equal(rep.source.deviceScaleFactor, 2);
    equal(rep.source.fps, 60);
    equal(rep.stagingOrigin, server.origin);
    equal(rep.piiPolicy, 'demo-tenant-only');
    deepEqual(rep.pii, { scanned: 0, hits: [] });
    deepEqual(rep.thirdPartyRequests, []);
    ok(!fs.readdirSync(outDir).some((n) => n.startsWith('.frames')), 'frame dirs are deleted');
  });

  await t.test('webm is VP9, 60 fps CFR, >= 1920x1080, duration within 0.3 s of last beat end', async () => {
    for (const f of rep.flows) {
      const probe = await ffprobeJson(bins.ffprobe, path.join(outDir, f.video));
      const v = probe.streams.find((s) => s.codec_type === 'video');
      equal(v.codec_name, 'vp9');
      equal(v.r_frame_rate, '60/1');
      ok(v.width >= 1920 && v.height >= 1080);
      deepEqual(rep.source.videoSize, { w: v.width, h: v.height });
      const dur = Number(probe.format.duration);
      ok(Math.abs(dur - f.beats.at(-1).t1) <= 0.3, `${f.name}: duration ${dur} vs last beat end ${f.beats.at(-1).t1}`);
    }
  });

  await t.test('rent-collection footage runs at least 14 s', () => {
    ok(rep.flows[1].durationSec >= 14, `durationSec ${rep.flows[1].durationSec}`);
  });

  await t.test('capture reports medianFps >= 30', () => {
    ok(rep.flows.every((f) => f.screencast.medianFps >= 30 && f.screencast.frames > 30));
  });

  await t.test('beat timestamps are monotonic and every beat holds >= 0.6 s', () => {
    for (const f of rep.flows) {
      ok(f.beats.length > 0);
      ok(f.beats.every((b, i) => b.index === i && b.t1 - b.t0 >= 0.6 && (i === 0 || b.t0 >= f.beats[i - 1].t1)), f.name);
      ok(f.beats[0].t0 >= 0);
    }
    deepEqual(rep.flows[0].beats.map((b) => b.kind), ['goto', 'fill', 'click', 'settle']);
    deepEqual(rep.flows[0].settles.map((s) => s.index), [3]);
    equal(rep.flows[0].settles[0].still, 'tenant-onboarding-1.png');
  });

  await t.test('hide selectors are display:none and counted', () => {
    ok(rep.flows[0].hidden['.cookie-banner'] >= 1);
    deepEqual(report.flows[0].hidden, rep.flows[0].hidden);
  });
});

test('--feature payments runs only rent-collection', { skip }, async () => {
  const outDir = tmpDir('out');
  // Short waits: this test is about flow selection, not footage length (the happy path covers that).
  const cfg = path.join(tmpDir('config'), 'promo.yaml');
  fs.writeFileSync(cfg, fs.readFileSync(config(), 'utf8').replaceAll('wait: 3000', 'wait: 100'));
  const r = await runCliAsync(captureScript, ['--config', cfg, '--out', outDir, '--feature', 'payments']);
  equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  deepEqual(report.flows.map((f) => f.name), ['rent-collection']);
  ok(!fs.existsSync(path.join(outDir, 'tenant-onboarding.webm')));
});

test('unknown feature exits 1 naming the tag, before creating the output dir', () => {
  const outDir = path.join(tmpDir('out'), 'never');
  const r = runCli(captureScript, ['--config', config(), '--out', outDir, '--feature', 'nope']);
  equal(r.status, 1);
  match(r.stderr, /nope/);
  match(r.stderr, /tenants/);
  ok(!fs.existsSync(outDir));
});

test('invalid yaml exits 1 before any output dir is created and prints the field path', () => {
  const bad = configWith('pii_policy: demo-tenant-only', 'pii_policy: ""');
  const outDir = path.join(tmpDir('out'), 'never');
  const r = runCli(captureScript, ['--config', bad, '--out', outDir]);
  equal(r.status, 1);
  match(r.stderr, /\/pii_policy/);
  ok(!fs.existsSync(outDir));
});

test('stale selector: exit 3, stderr names flow + beat index + selector, failure screenshot, report.failed', { skip }, async () => {
  const outDir = tmpDir('out');
  const cfg = configWith('click: "text=Save tenant"', "click: '#does-not-exist'");
  const r = await runCliAsync(captureScript, ['--config', cfg, '--out', outDir], { PROMO_BEAT_TIMEOUT_MS: '1500' });
  equal(r.status, 3, r.stderr);
  match(r.stderr, /tenant-onboarding.*beat 2.*#does-not-exist/s);
  ok(fs.existsSync(path.join(outDir, 'failure-tenant-onboarding-beat2.png')));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  equal(report.status, 'failed');
  equal(report.failed.kind, 'selector');
  equal(report.failed.flow, 'tenant-onboarding');
  equal(report.failed.beatIndex, 2);
  equal(report.failed.screenshot, 'failure-tenant-onboarding-beat2.png');
  ok(!fs.existsSync(path.join(outDir, 'tenant-onboarding.webm')), 'no video for the failed flow');
  ok(!fs.existsSync(path.join(outDir, 'rent-collection.webm')), 'later flows are not run');
});

test('a page that never reaches network idle does not hang: beat proceeds with networkIdle:false', { skip }, async () => {
  const text = fs.readFileSync(config(), 'utf8');
  const head = text.slice(0, text.indexOf('flows:'));
  const file = path.join(tmpDir('config'), 'promo.yaml');
  fs.writeFileSync(file, `${head}flows:\n  - name: polling\n    beats:\n      - goto: /poll.html\n      - wait: 200\n`);
  const outDir = tmpDir('out');
  const started = Date.now();
  const rep = await runCapture({
    configPath: file, outDir, logger: quiet, env: { ...process.env, PROMO_IDLE_TIMEOUT_MS: '1000' },
  });
  equal(rep.status, 'ok');
  ok(rep.flows[0].beats.every((b) => b.networkIdle === false));
  ok(Date.now() - started < 60_000);
});

test('createLogger scrubs secrets from everything written', () => {
  const log = createLogger({ secrets: ['hunter2', ''] });
  equal(log.scrub('pw=hunter2 and hunter2'), 'pw=*** and ***');
  equal(log.scrub('nothing here'), 'nothing here');
});

test('serveDirs serves mounts, 404s traversal and honours handlers', async () => {
  const s = await serveDirs([{ prefix: '/', root: fixtureSite }], {
    handlers: { '/api/ping': (req, res) => res.end('pong') },
  });
  try {
    const get = async (p) => {
      const r = await fetch(`${s.origin}${p}`);
      return { status: r.status, type: r.headers.get('content-type'), body: await r.text() };
    };
    const css = await get('/site.css');
    equal(css.status, 200);
    match(css.type, /text\/css/);
    equal((await get('/')).status, 200);
    equal((await get('/api/ping')).body, 'pong');
    equal((await get('/nope.html')).status, 404);
    equal((await get('/..%2f..%2fscripts%2fpackage.json')).status, 404);
    equal((await get('/%2e%2e/%2e%2e/scripts/package.json')).status, 404);
  } finally {
    await s.close();
  }
});
