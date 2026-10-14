#!/usr/bin/env node
import { collectChecks, exitCodeFor } from './lib/doctor.js';

const checks = await collectChecks();
for (const c of checks) {
  console.log(`[${c.ok ? 'ok' : 'FAIL'}] ${c.name} - ${c.detail}`);
  if (!c.ok && c.fix) console.log(`       fix: ${c.fix}`);
}

// exitCode, not process.exit(): piped stdout must drain before the process ends.
process.exitCode = exitCodeFor(checks);
