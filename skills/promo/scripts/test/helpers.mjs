import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDir = path.resolve(here, '..');
export const fixtureSite = path.resolve(scriptsDir, '..', 'fixtures', 'demo-site');

let counter = 0;

// A fresh directory under test/.tmp/ (git-ignored). Unique per call so parallel test files never collide.
export function tmpDir(name) {
  const dir = path.join(here, '.tmp', `${name}-${process.pid}-${Date.now()}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A 60 fps, 1920x1080 VP9 clip: the same codec, rate and size the capture step writes. Every frame differs
// strongly from its neighbours (a smooth field whose phase moves with the frame number), so a seek that
// lands one source frame off scores far below one that lands exactly.
const clipSource = (seconds) => `color=c=black:s=64x36:r=60:d=${seconds},geq=r='128+127*sin(N*0.9+X*0.2)':g='128+127*sin(N*1.3+Y*0.3)':`
  + "b='128+127*sin(N*0.5+X*0.1+Y*0.1)',scale=1920:1080:flags=bicubic,format=yuv420p";

/** Writes `<flow>.webm` plus a capture report.json (status ok) into `dir`. */
export async function writeCapture(ffmpeg, dir, { flow = 'sample', seconds = 4 } = {}) {
  await run(ffmpeg, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', clipSource(seconds),
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-deadline', 'realtime', '-cpu-used', '8',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    path.join(dir, `${flow}.webm`),
  ]);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({
    version: 1, status: 'ok', flows: [{ name: flow, video: `${flow}.webm`, durationSec: seconds }],
  }));
}

/** A music directory holding `tone.wav` and its cues file; returns the directory. */
export async function writeToneMusicDir(ffmpeg, seconds = 2) {
  const dir = tmpDir('music');
  await run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}:sample_rate=48000`, path.join(dir, 'tone.wav')]);
  fs.copyFileSync(path.join(scriptsDir, 'test', 'fixtures', 'valid.cues.json'), path.join(dir, 'tone.cues.json'));
  return dir;
}

// Replaces {{KEY}} tokens (e.g. {{PORT}}, {{ORIGIN}}) and writes the result next to a scratch dir.
export function materializeConfig(templatePath, vars) {
  let text = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{{${key}}}`, value);
  const out = path.join(tmpDir('config'), 'promo.yaml');
  fs.writeFileSync(out, text);
  return out;
}

export function runCli(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: scriptsDir,
    timeout: 240_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Async twin of runCli. Use it whenever the test process hosts the loopback server: spawnSync blocks
// the event loop, so the child's requests would never be answered.
export function runCliAsync(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      cwd: scriptsDir,
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}
