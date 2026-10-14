import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
