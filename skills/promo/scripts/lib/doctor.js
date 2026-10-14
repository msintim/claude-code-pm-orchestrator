import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { TESSDATA_DIR } from './pii.js';
import { INSTALL_HINT, FfmpegNotFoundError, resolveFfmpeg, checkCapabilities } from './ffmpeg.js';

const MIN_NODE_MAJOR = 22;

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: 'node',
    ok,
    detail: `v${process.versions.node}`,
    ...(ok ? {} : { fix: `Install Node >=${MIN_NODE_MAJOR}` }),
  };
}

async function checkFfmpeg(env) {
  try {
    const bins = resolveFfmpeg({ env });
    const caps = await checkCapabilities(bins);
    if (caps.ok) return { name: 'ffmpeg', ok: true, detail: bins.ffmpeg };
    return {
      name: 'ffmpeg',
      ok: false,
      detail: `${bins.ffmpeg} lacks: ${caps.missing.join(', ')}`,
      fix: INSTALL_HINT,
    };
  } catch (e) {
    // INSTALL_HINT is reported once, as `fix`; strip it from the message used as detail.
    const detail = e instanceof FfmpegNotFoundError
      ? e.message.replace(INSTALL_HINT, '').trim() || 'ffmpeg/ffprobe not found'
      : e.message.split('\n')[0];
    return { name: 'ffmpeg', ok: false, detail, fix: INSTALL_HINT };
  }
}

function checkChromium() {
  const fix = 'npx playwright install chromium';
  try {
    const exe = chromium.executablePath();
    return fs.existsSync(exe)
      ? { name: 'playwright-chromium', ok: true, detail: exe }
      : { name: 'playwright-chromium', ok: false, detail: `not installed (${exe})`, fix };
  } catch (e) {
    return { name: 'playwright-chromium', ok: false, detail: e.message.split('\n')[0], fix };
  }
}

const MIN_TESSDATA_BYTES = 1024 * 1024;

function checkTessdata() {
  const file = path.join(TESSDATA_DIR, 'eng.traineddata');
  const fix = 'Restore skills/promo/scripts/vendor/tessdata/eng.traineddata (see the README beside it)';
  try {
    const { size } = fs.statSync(file);
    return size > MIN_TESSDATA_BYTES
      ? { name: 'tessdata', ok: true, detail: `${file} (${size} bytes)` }
      : { name: 'tessdata', ok: false, detail: `${file} is only ${size} bytes`, fix };
  } catch {
    return { name: 'tessdata', ok: false, detail: `missing ${file}`, fix };
  }
}

// A missing tool the pipeline needs is an environment problem (2); anything else that fails (an old Node) is 1.
const ENVIRONMENT_CHECKS = new Set(['ffmpeg', 'playwright-chromium', 'tessdata']);

export function exitCodeFor(checks) {
  const failed = checks.filter((c) => !c.ok);
  if (failed.some((c) => ENVIRONMENT_CHECKS.has(c.name))) return 2;
  return failed.length > 0 ? 1 : 0;
}

export async function collectChecks({ env = process.env } = {}) {
  return [checkNode(), await checkFfmpeg(env), checkChromium(), checkTessdata()];
}
