import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The Playwright-bundled ffmpeg is a VP8-only recorder build (no H.264/AAC, no overlay/xfade).
// It is never searched for and never used as a fallback.
export const INSTALL_HINT =
  'A full FFmpeg is required: winget install Gyan.FFmpeg | brew install ffmpeg | apt install ffmpeg (or set PROMO_FFMPEG to its directory).';

export class FfmpegNotFoundError extends Error {
  constructor(message = INSTALL_HINT) {
    super(message);
    this.name = 'FfmpegNotFoundError';
  }
}

const REQUIRED_ENCODERS = ['libx264', 'aac', 'libvpx-vp9'];
const REQUIRED_FILTERS = ['overlay', 'xfade', 'afade', 'volume', 'aloop'];

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function resolveFfmpeg({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  const ext = platform === 'win32' ? '.exe' : '';
  const ffmpegName = `ffmpeg${ext}`;
  const ffprobeName = `ffprobe${ext}`;
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);

  const findOnPath = (name) => {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    return null;
  };

  const override = env.PROMO_FFMPEG;
  if (override) {
    // A directory holding both binaries, or the ffmpeg binary itself (ffprobe is its sibling).
    const dirCandidate = path.join(override, ffmpegName);
    const ffmpeg = exists(dirCandidate) ? dirCandidate : exists(override) ? override : null;
    if (ffmpeg) {
      const ffprobe = path.join(path.dirname(ffmpeg), ffprobeName);
      if (exists(ffprobe)) return { ffmpeg, ffprobe };
    }
    // An explicit override that resolves to nothing is a configuration error, not a cue to guess from PATH.
    const bad = String(override).replace(/\s+/g, ' ');
    throw new FfmpegNotFoundError(
      `PROMO_FFMPEG is not usable: "${bad}" has no ffmpeg and ffprobe (not falling back to PATH). ${INSTALL_HINT}`,
    );
  }

  const ffmpeg = findOnPath(ffmpegName);
  if (ffmpeg) {
    const sibling = path.join(path.dirname(ffmpeg), ffprobeName);
    const ffprobe = exists(sibling) ? sibling : findOnPath(ffprobeName);
    if (ffprobe) return { ffmpeg, ffprobe };
  }
  throw new FfmpegNotFoundError();
}

// The flag column's width varies by ffmpeg version (-filters prints 3 chars in older builds, 2 in 9.x),
// so accept any short run of flag characters. Legend lines ("T.. = Timeline support") have "=" where
// a name would be and are skipped.
function listedNames(text) {
  const names = new Set();
  const line = /^\s*[A-Z.|]{1,6}\s+(?!=(?:\s|$))(\S+)/;
  for (const l of text.split(/\r?\n/)) {
    const m = line.exec(l);
    if (m) names.add(m[1]);
  }
  return names;
}

export function parseCapabilities(encodersText, filtersText) {
  const encoders = listedNames(encodersText);
  const filters = listedNames(filtersText);
  const missing = [
    ...REQUIRED_ENCODERS.filter((n) => !encoders.has(n)),
    ...REQUIRED_FILTERS.filter((n) => !filters.has(n)),
  ];
  return { ok: missing.length === 0, missing };
}

export function run(bin, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {}); // the child may exit before reading all input
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trimEnd().split(/\r?\n/).slice(-20).join('\n');
      reject(new Error(`${path.basename(bin)} exited with code ${code}\n${tail}`));
    });
    child.stdin.end(input);
  });
}

export async function checkCapabilities({ ffmpeg }) {
  const [encoders, filters] = await Promise.all([
    run(ffmpeg, ['-hide_banner', '-encoders']),
    run(ffmpeg, ['-hide_banner', '-filters']),
  ]);
  return parseCapabilities(encoders.stdout, filters.stdout);
}

export async function ffprobeJson(ffprobe, file) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  return JSON.parse(stdout);
}

let memo = null;

/** ffmpeg is missing or unusable. The CLI entry point maps this to exit 2; the library never exits. */
export class FfmpegUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FfmpegUnavailableError';
  }
}

export function requireFfmpeg() {
  memo ??= (async () => {
    try {
      const bins = resolveFfmpeg();
      const caps = await checkCapabilities(bins);
      if (!caps.ok) throw new Error(`${bins.ffmpeg} lacks: ${caps.missing.join(', ')}. ${INSTALL_HINT}`);
      return bins;
    } catch (e) {
      throw new FfmpegUnavailableError(e instanceof FfmpegNotFoundError ? e.message : `ffmpeg check failed: ${e.message.split('\n')[0]}`);
    }
  })();
  return memo;
}
