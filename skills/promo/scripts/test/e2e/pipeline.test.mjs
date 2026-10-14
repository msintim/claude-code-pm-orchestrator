// End to end: capture -> render -> reframe x2 -> loop -> posters on the fixture site, CLIs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpeg } from '../../lib/ffmpeg.js';
import { serveDirs } from '../../lib/server.js';
import { fixtureSite, materializeConfig, runCliAsync, scriptsDir, tmpDir } from '../helpers.mjs';

const { equal, deepEqual, ok } = assert;
const cli = (name) => path.join(scriptsDir, name);

let bins = null;
try { bins = resolveFfmpeg(); } catch { bins = null; }
const skip = bins === null ? 'no ffmpeg resolved (set PROMO_FFMPEG)' : false;

const probe = (file) => JSON.parse(spawnSync(bins.ffprobe, [
  '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file,
], { encoding: 'utf8' }).stdout);
const sizeOf = (file) => { const v = probe(file).streams.find((s) => s.codec_type === 'video'); return [v.width, v.height]; };
const durationOf = (file) => Number(probe(file).format.duration);
const hasAudio = (file) => probe(file).streams.some((s) => s.codec_type === 'audio');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function ok0(promise, label) {
  const r = await promise;
  equal(r.status, 0, `${label} exited ${r.status}\n${r.stderr}`);
  return r;
}

test('promo pipeline on the fixture site', { skip, timeout: 20 * 60_000 }, async (t) => {
  const site = await serveDirs([{ prefix: '/', root: fixtureSite }]);
  t.after(() => site.close());

  const run = tmpDir('e2e-run');
  const capture = path.join(run, 'capture');
  const scenes = path.join(fixtureSite, 'scenes.json');
  const musicDir = tmpDir('e2e-music');
  const env = { PROMO_MUSIC_DIR: musicDir };
  const timings = {};
  const timed = async (name, fn) => { const s = Date.now(); const v = await fn(); timings[name] = ((Date.now() - s) / 1000).toFixed(1); return v; };

  // The 2 s tone and its cues are the only music; no LICENSES.md, so no attribution is required.
  const { run: ffRun } = await import('../../lib/ffmpeg.js');
  await ffRun(bins.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', path.join(musicDir, 'test-tone.wav')]);
  fs.writeFileSync(path.join(musicDir, 'test-tone.cues.json'), JSON.stringify({
    schemaVersion: 1,
    source: { filename: 'test-tone.wav', trackStem: 'test-tone' },
    duration: 2,
    tempo: 120,
    beats: [0.5, 1, 1.5],
    strongCues: [{ time: 0.5, intensity: 0.9 }, { time: 1.5, intensity: 0.7 }],
  }));

  await t.test('capture succeeds and PII is clean', async () => {
    const config = materializeConfig(path.join(fixtureSite, '.promo', 'promo.yaml'), { ORIGIN: site.origin });
    await timed('capture', () => ok0(runCliAsync(cli('capture.mjs'), ['--config', config, '--out', capture]), 'capture'));
    const report = readJson(path.join(capture, 'report.json'));
    equal(report.status, 'ok');
    equal(report.pii.hits.length, 0);
  });

  await t.test('master render (twice) and identical frameSequenceSha256', async () => {
    await timed('render-master', () => ok0(runCliAsync(cli('render.mjs'), ['--scenes', scenes, '--capture', capture, '--out', run], env), 'render'));
    const r1 = readJson(path.join(run, 'render-report.json'));
    const second = path.join(run, 'second');
    await timed('render-master-2', () => ok0(runCliAsync(cli('render.mjs'), ['--scenes', scenes, '--capture', capture, '--out', second], env), 'render 2'));
    const r2 = readJson(path.join(second, 'render-report.json'));
    ok(r1.frameSequenceSha256);
    equal(r1.frameSequenceSha256, r2.frameSequenceSha256);
  });

  await t.test('reframe 1x1 and 9x16', async () => {
    for (const ratio of ['1x1', '9x16']) {
      const out = path.join(run, ratio === '1x1' ? 'feed-1x1.mp4' : 'reel-9x16.mp4');
      const stills = path.join(run, `stills-${ratio}`);
      await timed(`reframe-${ratio}`, () => ok0(runCliAsync(cli('reframe.mjs'), ['--scenes', scenes, '--capture', capture, '--ratio', ratio, '--out', out, '--stills', stills], env), `reframe ${ratio}`));
    }
  });

  await t.test('master stills', async () => {
    await timed('stills-16x9', () => ok0(runCliAsync(cli('render.mjs'), ['--scenes', scenes, '--capture', capture, '--out', path.join(run, 'stills'), '--stills'], env), 'stills'));
  });

  await t.test('hero loop', async () => {
    await timed('loop', () => ok0(runCliAsync(cli('loop.mjs'), ['--scenes', scenes, '--capture', capture, '--out', run], env), 'loop'));
  });

  await t.test('posters (baked for the three, --no-bake for the hero)', async () => {
    // The footage scene's midpoint still of the matching ratio: poster.mjs needs a still at the video's size.
    const still = (dir) => {
      const file = path.join(run, dir, 'scene-02-mid.png');
      ok(fs.existsSync(file), `${file} exists`);
      return file;
    };
    const bake = (video, dir, out, jpg) => ok0(runCliAsync(cli('poster.mjs'), ['--video', path.join(run, video), '--still', still(dir), '--out', path.join(run, out), '--poster', path.join(run, jpg)]), `poster ${out}`);
    await bake('master-16x9.mp4', 'stills', 'feed-16x9.mp4', 'poster-16x9.jpg');
    // reframe already wrote feed-1x1.mp4 and reel-9x16.mp4; poster.mjs may bake over its own input.
    await bake('feed-1x1.mp4', 'stills-1x1', 'feed-1x1.mp4', 'poster-1x1.jpg');
    await bake('reel-9x16.mp4', 'stills-9x16', 'reel-9x16.mp4', 'poster-9x16.jpg');
    await ok0(runCliAsync(cli('poster.mjs'), ['--video', path.join(run, 'hero-loop.mp4'), '--still', still('stills'), '--poster', path.join(run, 'poster-hero.jpg'), '--no-bake']), 'poster hero');
  });

  await t.test('three mp4 playable with exact sizes', () => {
    deepEqual(sizeOf(path.join(run, 'feed-16x9.mp4')), [1920, 1080]);
    deepEqual(sizeOf(path.join(run, 'feed-1x1.mp4')), [1080, 1080]);
    deepEqual(sizeOf(path.join(run, 'reel-9x16.mp4')), [1080, 1920]);
    for (const f of ['feed-16x9.mp4', 'feed-1x1.mp4', 'reel-9x16.mp4']) {
      const d = durationOf(path.join(run, f));
      ok(Math.abs(d - 16.5) < 0.1, `${f} lasts ${d} s`);
      ok(hasAudio(path.join(run, f)), `${f} has audio`);
    }
  });

  await t.test('hero loop mp4 + webm: 1920x1080, 8..15 s, no audio', () => {
    for (const f of ['hero-loop.mp4', 'hero-loop.webm']) {
      const file = path.join(run, f);
      deepEqual(sizeOf(file), [1920, 1080]);
      const d = durationOf(file);
      ok(d >= 8 && d <= 15, `${f} lasts ${d} s`);
      ok(!hasAudio(file), `${f} has no audio`);
    }
  });

  await t.test('posters exist as jpg and match output sizes; hero poster not baked', () => {
    const expected = { 'poster-16x9.jpg': [1920, 1080], 'poster-1x1.jpg': [1080, 1080], 'poster-9x16.jpg': [1080, 1920], 'poster-hero.jpg': null };
    for (const [name, size] of Object.entries(expected)) {
      const file = path.join(run, name);
      ok(fs.existsSync(file), `${name} exists`);
      if (size) deepEqual(sizeOf(file), size);
    }
    // --no-bake leaves the loop alone: the hero video still lasts what loop.mjs wrote.
    ok(fs.existsSync(path.join(run, 'hero-loop.mp4')));
  });

  await t.test('reel layout: reframe-report has no warnings other than coverage', () => {
    for (const ratio of ['1x1', '9x16']) {
      const rep = readJson(path.join(run, `reframe-report-${ratio}.json`));
      for (const w of rep.warnings ?? []) ok(/crop keeps only/.test(w), `unexpected warning: ${w}`);
    }
  });

  t.diagnostic(`e2e timings (s): ${JSON.stringify(timings)}`);
});
