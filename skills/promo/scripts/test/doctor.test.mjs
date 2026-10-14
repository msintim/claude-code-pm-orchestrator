import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectChecks } from '../lib/doctor.js';
import { INSTALL_HINT } from '../lib/ffmpeg.js';

test('doctor reports a missing ffmpeg as a failure carrying the install hint', async () => {
  const checks = await collectChecks({ env: { PATH: '' } });
  const ffmpeg = checks.find((c) => c.name === 'ffmpeg');
  assert.ok(ffmpeg);
  assert.equal(ffmpeg.ok, false);
  assert.equal(ffmpeg.fix, INSTALL_HINT);
});

test('doctor passes the node version check on a supported runtime', async () => {
  const checks = await collectChecks({ env: { PATH: '' } });
  const node = checks.find((c) => c.name === 'node');
  assert.ok(node);
  assert.equal(node.ok, true);
});

test('every check has a name, boolean ok and a detail string', async () => {
  const checks = await collectChecks({ env: { PATH: '' } });
  for (const c of checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.detail, 'string');
  }
});
