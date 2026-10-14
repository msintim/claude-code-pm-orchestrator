// The PII gate fails a capture closed, and every downstream CLI refuses the failed capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpeg } from '../../lib/ffmpeg.js';
import { serveDirs } from '../../lib/server.js';
import { fixtureSite, materializeConfig, runCliAsync, scriptsDir, tmpDir } from '../helpers.mjs';

const { equal, ok, match } = assert;
const cli = (name) => path.join(scriptsDir, name);

let skip = false;
try { resolveFfmpeg(); } catch { skip = 'no ffmpeg resolved (set PROMO_FFMPEG)'; }

test('a PII hit fails the capture and downstream refuses it', { skip, timeout: 10 * 60_000 }, async () => {
  const site = await serveDirs([{ prefix: '/', root: fixtureSite }]);
  try {
    const config = materializeConfig(path.join(fixtureSite, '.promo', 'promo.pii.yaml'), { ORIGIN: site.origin });
    const outDir = path.join(tmpDir('e2e-pii'), 'capture');
    const r = await runCliAsync(cli('capture.mjs'), ['--config', config, '--out', outDir]);
    equal(r.status, 1, r.stderr);
    match(r.stderr, /pii-flow-1\.png/);
    match(r.stderr, /email/);
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    equal(report.status, 'failed');
    equal(report.failed.kind, 'pii');
    ok(!fs.existsSync(path.join(outDir, 'pii-flow.webm')), 'no video is kept for a failed capture');

    const scenes = path.join(fixtureSite, 'scenes.json');
    const rr = await runCliAsync(cli('render.mjs'), ['--scenes', scenes, '--capture', outDir, '--out', tmpDir('e2e-pii-out')]);
    equal(rr.status, 1);
    match(rr.stderr, /status/);
  } finally {
    await site.close();
  }
});
