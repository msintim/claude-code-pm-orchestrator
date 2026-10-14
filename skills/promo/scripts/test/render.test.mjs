import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openCompositor, renderVideo } from '../lib/render-core.js';
import { requireFfmpeg, run, ffprobeJson } from '../lib/ffmpeg.js';
import { captionRect } from '../lib/geometry.js';
import { tmpDir, runCliAsync, scriptsDir, writeCapture, writeToneMusicDir } from './helpers.mjs';

const SIZE = { w: 1920, h: 1080 };
const BRAND = { primary: '#1d4ed8', accent: '#f59e0b', font: 'sans-serif', theme: 'light' };
const FOOTAGE = (extra = {}) => ({ type: 'footage', flow: 'sample', in: 0, out: 3, caption: 'Record a payment', transition: 'none', ...extra });
const render = path.join(scriptsDir, 'render.mjs');

let bins;
let captureDir;
const opened = [];

before(async () => {
  bins = await requireFfmpeg();
  captureDir = tmpDir('render-capture');
  await writeCapture(bins.ffmpeg, captureDir);
});
after(async () => { await Promise.all(opened.map((c) => c.close())); });

const open = async (scenes, size = SIZE) => {
  const c = await openCompositor({ scenes, brand: BRAND, size, captureDir });
  opened.push(c);
  return c;
};

async function psnr(a, b) {
  const { stderr } = await run(bins.ffmpeg, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']);
  const m = /average:(\S+)/.exec(stderr);
  assert.ok(m, `no psnr in: ${stderr.slice(-300)}`);
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}

test('video seek is frame-exact: frame k from the compositor matches ffmpeg extract (PSNR > 35 dB)', async () => {
  const c = await open([FOOTAGE({ caption: undefined })]);
  const dir = tmpDir('seek');
  const values = {};
  const neighbours = {};
  for (const k of [0, 1, 29, 30, 31, 89]) {
    await c.drive(k / 30);
    const got = path.join(dir, `got-${k}.png`);
    fs.writeFileSync(got, await c.shot());
    const extract = async (n) => {
      const want = path.join(dir, `want-${n}.png`);
      await run(bins.ffmpeg, [
        '-hide_banner', '-y', '-i', path.join(captureDir, 'sample.webm'),
        '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-fps_mode', 'passthrough', want,
      ]);
      return want;
    };
    // 30 fps frame k plays source frame 2k of the 60 fps recording.
    values[k] = await psnr(got, await extract(2 * k));
    neighbours[k] = await psnr(got, await extract(2 * k + 1)); // one source frame late
  }
  console.log('seek PSNR by k:', JSON.stringify(values));
  console.log('PSNR against the next source frame:', JSON.stringify(neighbours));
  for (const [k, v] of Object.entries(values)) {
    assert.ok(v > 35, `k=${k} PSNR ${v}`);
    assert.ok(v > neighbours[k] + 10, `k=${k} is not distinguishable from the neighbouring source frame`);
  }
});

test('footage frames are order-independent', async () => {
  const c = await open([FOOTAGE()]);
  const shots = {};
  for (const t of [2.9, 0, 1, 0.5, 1, 2.9, 0]) {
    await c.drive(t);
    const png = (await c.shot()).toString('base64');
    if (shots[t]) assert.equal(png, shots[t], `t=${t} changed between visits`);
    shots[t] = png;
  }
});

test('focus zooms the master: a footage scene with focus differs from the same scene without', async () => {
  const plain = await open([FOOTAGE({ caption: undefined })]);
  await plain.drive(1);
  const a = await plain.shot();
  const zoomed = await open([FOOTAGE({ caption: undefined, focus: { x: 100, y: 100, w: 480, h: 270 } })]);
  await zoomed.drive(1);
  const b = await zoomed.shot();
  assert.notDeepEqual(a, b);
  const dir = tmpDir('focus');
  fs.writeFileSync(path.join(dir, 'a.png'), a);
  fs.writeFileSync(path.join(dir, 'b.png'), b);
  assert.ok(await psnr(path.join(dir, 'a.png'), path.join(dir, 'b.png')) < 30);
});

test('caption bar text is set from scene.caption and sits at captionRect(size)', async () => {
  for (const size of [SIZE, { w: 1080, h: 1920 }]) {
    const c = await open([FOOTAGE()], size);
    await c.drive(1);
    const got = await c.page.evaluate(() => {
      const bar = document.querySelector('[data-template="caption-bar"]');
      const r = bar.getBoundingClientRect();
      return { text: bar.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const want = captionRect(size);
    assert.equal(got.text, 'Record a payment');
    for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(got[key] - want[key]) < 1, `${size.w}x${size.h} ${key}: ${got[key]} vs ${want[key]}`);
  }
});

test('compositor can play the capture codec: video.error === null and readyState >= 2 for a VP9 webm', async () => {
  const c = await open([FOOTAGE()]);
  await c.drive(0.5);
  const state = await c.page.evaluate(() => {
    const v = document.querySelector('video');
    return { error: v.error, readyState: v.readyState, w: v.videoWidth, h: v.videoHeight };
  });
  assert.equal(state.error, null);
  assert.ok(state.readyState >= 2);
  assert.deepEqual([state.w, state.h], [1920, 1080]);
});

const SMALL = {
  brand: BRAND,
  scenes: [
    { type: 'hook', duration: 1, text: 'Hello', transition: 'dip-to-brand' },
    FOOTAGE({ in: 0.5, out: 1.5, caption: 'Pay in one tap', focus: { x: 200, y: 100, w: 800, h: 450 }, transition: 'slide' }),
    { type: 'outro', duration: 0.5, text: 'Done', sub: 'promo.example', transition: 'none' },
  ],
};

async function doRender(name, extra = {}) {
  const dir = tmpDir(name);
  const t0 = Date.now();
  const report = await renderVideo({
    scenes: SMALL, size: SIZE, captureDir, outFile: path.join(dir, 'master-16x9.mp4'),
    workDir: path.join(dir, 'work'), ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, ...extra,
  });
  console.log(`render ${name}: ${report.frames} frames in ${Date.now() - t0} ms`);
  return { dir, report };
}

let first;
test('master mp4 is 1920x1080 h264 yuv420p 30 fps, duration = frames/30 +/- 0.05, silent has no audio stream', async () => {
  first = await doRender('master', { keepFrames: true });
  const probe = await ffprobeJson(bins.ffprobe, path.join(first.dir, 'master-16x9.mp4'));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(v.width, 1920);
  assert.equal(v.height, 1080);
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(probe.streams.some((s) => s.codec_type === 'audio'), false);
  assert.ok(Math.abs(Number(probe.format.duration) - first.report.frames / 30) <= 0.05);
  assert.equal(first.report.frames, 75);
  assert.equal(fs.readdirSync(path.join(first.dir, 'work', 'frames')).length, 75, 'keepFrames keeps the PNGs');
});

test('render-report.json lists frames, checksum and encode settings (crf 18)', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(first.dir, 'render-report.json'), 'utf8'));
  assert.deepEqual(onDisk, first.report);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.fps, 30);
  assert.equal(onDisk.frames, 75);
  assert.match(onDisk.frameSequenceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(onDisk.encode, { codec: 'libx264', crf: 18, pix_fmt: 'yuv420p', preset: 'slow', movflags: '+faststart' });
  assert.equal(onDisk.audio, null);
  assert.deepEqual(onDisk.cueAlignment, []);
  assert.deepEqual(onDisk.layoutIssues, []);
});

test('without keepFrames the frame PNGs are deleted; --webm adds a VP9 master', async () => {
  const { dir } = await doRender('webm', { webm: true });
  assert.equal(fs.existsSync(path.join(dir, 'work', 'frames')), false);
  const probe = await ffprobeJson(bins.ffprobe, path.join(dir, 'master-16x9.webm'));
  assert.equal(probe.streams.find((s) => s.codec_type === 'video').codec_name, 'vp9');
});

test('two renders of the same scenes have identical frameSequenceSha256', async () => {
  const second = await doRender('repeat');
  assert.equal(second.report.frameSequenceSha256, first.report.frameSequenceSha256);
});

test('music null -> no audio stream; music set -> one aac stream with duration == video +/- 0.05; cueAlignment filled', async () => {
  const musicDir = await writeToneMusicDir(bins.ffmpeg);

  const { dir, report } = await doRender('music', { music: { track: 'tone', gain_db: -10, musicDir } });
  const probe = await ffprobeJson(bins.ffprobe, path.join(dir, 'master-16x9.mp4'));
  const audio = probe.streams.filter((s) => s.codec_type === 'audio');
  const video = probe.streams.find((s) => s.codec_type === 'video');
  assert.equal(audio.length, 1);
  assert.equal(audio[0].codec_name, 'aac');
  assert.ok(Math.abs(Number(audio[0].duration) - Number(video.duration)) <= 0.05, `audio ${audio[0].duration} vs video ${video.duration}`);
  assert.ok(Math.abs(Number(probe.format.duration) - report.frames / 30) <= 0.05);

  assert.equal(report.audio.track, 'tone');
  assert.equal(report.audio.gainDb, -10);
  assert.equal(report.audio.duckDb, -6, 'duck_db defaults to -6 dB');
  assert.deepEqual(report.cueAlignment.map((a) => a.t), [1, 2], 'one entry per interior scene boundary');
  assert.equal(report.cueAlignment[0].nearest, 0.5);
  assert.equal(report.cueAlignment[0].within, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'render-report.json'), 'utf8')), report);
  assert.equal(first.report.frameSequenceSha256, report.frameSequenceSha256, 'music does not change the frames');
});

test('a bundled track renders and records its CC BY credit line in render-report.json', async () => {
  const { dir, report } = await doRender('music-bundled', { music: { track: 'happy-beats-business-moves-vol-3' } });
  const credit = '"Happy Beats & Business Moves Vol. 3" by Sascha Ende, CC-BY-4.0, https://ende.app/en/song/12868-happy-beats-business-moves-vol-3';
  assert.equal(report.audio.attribution, credit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'render-report.json'), 'utf8')).audio.attribution, credit);
});

test('an unknown music track is refused before any frame is rendered, naming the file', async () => {
  const musicDir = tmpDir('render-music-empty');
  await assert.rejects(doRender('music-missing', { music: { track: 'ghost', musicDir } }), /ghost\.mp3/);
});

// CLI refusals.
const goodScenes = () => JSON.parse(fs.readFileSync(path.join(scriptsDir, 'test', 'fixtures', 'valid-scenes.json'), 'utf8'));
function cliEnv(flowName = 'rent-collection', { status = 'ok', webm = true } = {}) {
  const dir = tmpDir('cli-capture');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({
    version: 1, status, flows: [{ name: flowName, video: `${flowName}.webm`, durationSec: 20 }],
  }));
  if (webm) fs.copyFileSync(path.join(captureDir, 'sample.webm'), path.join(dir, `${flowName}.webm`));
  return dir;
}
const writeScenes = (obj) => {
  const file = path.join(tmpDir('cli-scenes'), 'scenes.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};

test('CLI refuses invalid scenes.json (exit 1, prints the field path)', async () => {
  const bad = goodScenes();
  bad.scenes[0].duration = 'long';
  const r = await runCliAsync(render, ['--scenes', writeScenes(bad), '--capture', cliEnv(), '--out', tmpDir('out')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\/scenes\/0\/duration/);
});

test('CLI refuses a capture report with status failed (exit 1)', async () => {
  const r = await runCliAsync(render, ['--scenes', writeScenes(goodScenes()), '--capture', cliEnv('rent-collection', { status: 'failed' }), '--out', tmpDir('out')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /failed/);
});

test('CLI names the missing flow video when scenes reference a flow with no webm', async () => {
  const r = await runCliAsync(render, ['--scenes', writeScenes(goodScenes()), '--capture', cliEnv('rent-collection', { webm: false }), '--out', tmpDir('out')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rent-collection\.webm/);
});

test('unknown brand.font is refused naming the font (exit 1, a scenes.json value to fix)', async () => {
  const doc = goodScenes();
  doc.brand.font = 'Definitely Not A Font 123';
  const r = await runCliAsync(render, ['--scenes', writeScenes(doc), '--capture', cliEnv(), '--out', tmpDir('out')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Definitely Not A Font 123/);
});

test('a throw while rendering a frame is reported: the message handler posts frame-error and drive() rejects', async () => {
  const c = await open([FOOTAGE({ caption: undefined })]);
  // A BigInt time makes the timeline arithmetic throw a TypeError inside renderFrame.
  const reply = await c.page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'frame-error' || e.data?.type === 'frame-ready') resolve(e.data);
    });
    window.postMessage({ type: 'render', t: 1n }, location.origin);
  }));
  assert.equal(reply.type, 'frame-error');
  assert.match(reply.message, /BigInt|convert/i);
  await assert.rejects(c.page.evaluate(() => window.__promo.renderFrame(1n)), /BigInt|convert/i);
});
