import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  INSTALL_HINT,
  FfmpegNotFoundError,
  resolveFfmpeg,
  parseCapabilities,
  checkCapabilities,
} from '../lib/ffmpeg.js';

const PW_FFMPEG = path.join(
  process.env.LOCALAPPDATA ?? '',
  'ms-playwright',
  'ffmpeg-1011',
  'ffmpeg-win64.exe',
);

// Synchronous so it can feed the `skip` option of the tests below.
function resolveFullFfmpegSync() {
  try {
    const bins = resolveFfmpeg();
    const run = (args) => spawnSync(bins.ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).stdout ?? '';
    return parseCapabilities(run(['-encoders']), run(['-filters'])).ok ? bins : null;
  } catch {
    return null;
  }
}
const fullFfmpeg = resolveFullFfmpegSync();
const hasFullFfmpeg = fullFfmpeg !== null;

test('PROMO_FFMPEG directory wins over PATH', () => {
  const exists = (p) => p.startsWith(path.join('/opt/ff')) || p.startsWith(path.join('/usr/bin'));
  const r = resolveFfmpeg({ env: { PROMO_FFMPEG: '/opt/ff', PATH: '/usr/bin' }, platform: 'linux', exists });
  assert.equal(r.ffmpeg, path.join('/opt/ff', 'ffmpeg'));
  assert.equal(r.ffprobe, path.join('/opt/ff', 'ffprobe'));
});

test('PROMO_FFMPEG pointing at the binary derives ffprobe from its sibling', () => {
  const known = new Set([path.join('/opt/ff', 'ffmpeg'), path.join('/opt/ff', 'ffprobe')]);
  const r = resolveFfmpeg({
    env: { PROMO_FFMPEG: path.join('/opt/ff', 'ffmpeg'), PATH: '' },
    platform: 'linux',
    exists: (p) => known.has(p),
  });
  assert.equal(r.ffmpeg, path.join('/opt/ff', 'ffmpeg'));
  assert.equal(r.ffprobe, path.join('/opt/ff', 'ffprobe'));
});

test('falls back to PATH when PROMO_FFMPEG unset', () => {
  const known = new Set([path.join('/usr/bin', 'ffmpeg'), path.join('/usr/bin', 'ffprobe')]);
  const r = resolveFfmpeg({ env: { PATH: `/nope:/usr/bin` }, platform: 'linux', exists: (p) => known.has(p) });
  assert.equal(r.ffmpeg, path.join('/usr/bin', 'ffmpeg'));
  assert.equal(r.ffprobe, path.join('/usr/bin', 'ffprobe'));
});

test('windows PATH lookup uses ; and .exe names', () => {
  const dir = 'C:\\tools\\ff';
  const known = new Set([path.join(dir, 'ffmpeg.exe'), path.join(dir, 'ffprobe.exe')]);
  const r = resolveFfmpeg({ env: { PATH: `C:\\nope;${dir}` }, platform: 'win32', exists: (p) => known.has(p) });
  assert.equal(r.ffmpeg, path.join(dir, 'ffmpeg.exe'));
  assert.equal(r.ffprobe, path.join(dir, 'ffprobe.exe'));
});

test('missing everywhere throws FfmpegNotFoundError with a one-line hint', () => {
  assert.throws(
    () => resolveFfmpeg({ env: { PATH: '' }, platform: 'linux', exists: () => false }),
    (e) =>
      e instanceof FfmpegNotFoundError &&
      !/\n/.test(e.message) &&
      e.message.includes('winget install Gyan.FFmpeg') &&
      e.message.includes('brew install ffmpeg') &&
      e.message.includes('apt install ffmpeg'),
  );
});

test('PROMO_FFMPEG set but unusable throws and does not fall back to PATH', () => {
  const bad = path.join('/opt/missing');
  const onPath = new Set([path.join('/usr/bin', 'ffmpeg'), path.join('/usr/bin', 'ffprobe')]);
  assert.throws(
    () => resolveFfmpeg({ env: { PROMO_FFMPEG: bad, PATH: '/usr/bin' }, platform: 'linux', exists: (p) => onPath.has(p) }),
    (e) =>
      e instanceof FfmpegNotFoundError &&
      !/\n/.test(e.message) &&
      e.message.includes(bad) &&
      e.message.includes('PROMO_FFMPEG is not usable'),
  );
});

test('empty PROMO_FFMPEG falls through to PATH', () => {
  const known = new Set([path.join('/usr/bin', 'ffmpeg'), path.join('/usr/bin', 'ffprobe')]);
  const r = resolveFfmpeg({ env: { PROMO_FFMPEG: '', PATH: '/usr/bin' }, platform: 'linux', exists: (p) => known.has(p) });
  assert.equal(r.ffmpeg, path.join('/usr/bin', 'ffmpeg'));
});

test('INSTALL_HINT is one line and names PROMO_FFMPEG', () => {
  assert.ok(!/\n/.test(INSTALL_HINT));
  assert.ok(INSTALL_HINT.includes('PROMO_FFMPEG'));
});

test('never probes ms-playwright paths', () => {
  const seen = [];
  try {
    resolveFfmpeg({ env: { PATH: '/x' }, platform: 'win32', exists: (p) => (seen.push(p), false) });
  } catch {}
  assert.ok(seen.length > 0);
  assert.ok(seen.every((p) => !/ms-playwright/i.test(p)));
});

test('parseCapabilities rejects a VP8-only recorder build', () => {
  const r = parseCapabilities(' V....D libvpx   libvpx VP8', ' T.. scale  V->V');
  assert.equal(r.ok, false);
  for (const m of ['libx264', 'aac', 'libvpx-vp9', 'overlay', 'xfade']) assert.ok(r.missing.includes(m));
});

test('parseCapabilities accepts a full build listing', () => {
  const encoders = [
    ' V....D libx264              libx264 H.264',
    ' A....D aac                  AAC (Advanced Audio Coding)',
    ' V....D libvpx-vp9           libvpx VP9',
  ].join('\n');
  const filters = ['overlay', 'xfade', 'afade', 'volume', 'aloop']
    .map((n) => ` TSC ${n.padEnd(14)} V->V  something`)
    .join('\n');
  assert.deepEqual(parseCapabilities(encoders, filters), { ok: true, missing: [] });
});

const FULL_ENCODERS = [
  ' V....D libx264              libx264 H.264',
  ' A....D aac                  AAC (Advanced Audio Coding)',
  ' V....D libvpx-vp9           libvpx VP9',
].join('\n');

const FFMPEG9_FILTERS = [
  'Filters:',
  '  T.. = Timeline support',
  '  .S. = Slice threading',
  '  A = Audio input/output',
  '  V = Video input/output',
  '  N = Dynamic number and/or type of input/output',
  '  | = Source or sink filter',
  '  ------',
  ' TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.',
  ' .. abench            A->A       Benchmark part of a filtergraph.',
  ' T. afade             A->A       Fade in/out input audio.',
  ' .. aloop             A->A       Loop audio samples.',
  ' T. volume            A->A       Change input volume.',
  ' TS overlay           VV->V      Overlay a video source on top of the input.',
  ' .S xfade             VV->V      Cross fade one video with another video.',
].join('\n');

test('parseCapabilities accepts the 2-char filter flag column printed by ffmpeg 9', () => {
  assert.deepEqual(parseCapabilities(FULL_ENCODERS, FFMPEG9_FILTERS), { ok: true, missing: [] });
});

test('parseCapabilities still accepts the legacy 3-char filter flag column', () => {
  const filters = [
    ' TSC overlay  VV->V  Overlay a video source.',
    ' ... xfade    VV->V  Cross fade.',
    ' T.C afade    A->A   Fade audio.',
    ' T.. volume   A->A   Change volume.',
    ' ... aloop    A->A   Loop audio.',
  ].join('\n');
  assert.deepEqual(parseCapabilities(FULL_ENCODERS, filters), { ok: true, missing: [] });
});

test('parseCapabilities does not read legend lines as names', () => {
  const legendOnly = [
    'Filters:',
    '  T.. = Timeline support',
    '  .S. = Slice threading',
    '  A = Audio input/output',
    '  V = Video input/output',
    '  | = Source or sink filter',
    '  ------',
  ].join('\n');
  const r = parseCapabilities(' V..... = Video\n A..... = Audio\n' + FULL_ENCODERS, legendOnly);
  assert.equal(r.ok, false);
  for (const m of ['overlay', 'xfade', 'afade', 'volume', 'aloop']) assert.ok(r.missing.includes(m));
  const legendEncoders = parseCapabilities(' V..... = Video\n A..... = Audio\n S..... = Subtitle', FFMPEG9_FILTERS);
  assert.deepEqual(legendEncoders.missing, ['libx264', 'aac', 'libvpx-vp9']);
});

test('Playwright bundled ffmpeg fails checkCapabilities', { skip: !fs.existsSync(PW_FFMPEG) }, async () => {
  const r = await checkCapabilities({ ffmpeg: PW_FFMPEG });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('libx264'));
});

test('checkCapabilities passes on the resolved full ffmpeg', { skip: !hasFullFfmpeg }, async () => {
  const r = await checkCapabilities(fullFfmpeg);
  assert.deepEqual(r, { ok: true, missing: [] });
});
