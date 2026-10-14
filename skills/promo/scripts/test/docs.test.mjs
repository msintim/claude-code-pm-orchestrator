import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { TEXT_LIMITS, validatePromoConfig } from '../lib/schema.js';

const skillDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = path.resolve(skillDir, '../..');
// A Windows checkout with core.autocrlf turns LF into CRLF; the assertions below are written for LF.
const read = (...p) => fs.readFileSync(path.join(skillDir, ...p), 'utf8').replaceAll('\r\n', '\n');

const skill = read('SKILL.md');
const compose = read('references', 'compose.md');
const ATTRIBUTION = 'Portions adapted from latent-spaces/brag (MIT), Copyright (c) 2026 Shunit Haviv Hakimi.';
const BRAG_FILES = ['SKILL.md', 'references/plan.md', 'references/compose.md', 'references/deliver.md'];

test('SKILL.md frontmatter is exactly name+description, name === "promo", body <= 250 lines', () => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  assert.ok(m, 'frontmatter block present');
  const fm = YAML.parse(m[1]);
  assert.deepEqual(Object.keys(fm).sort(), ['description', 'name']);
  assert.equal(fm.name, 'promo');
  assert.equal(typeof fm.description, 'string');
  assert.equal(m[1].split('\n').filter((l) => l.trim()).length, 2, 'description is a single line');
  assert.ok(m[2].trimEnd().split('\n').length <= 250, 'body is at most 250 lines');
});

test('every references/*.md and scripts/*.mjs path mentioned in SKILL.md exists', () => {
  const mentioned = new Set(skill.match(/\b(?:references|scripts|examples|tools|assets)\/[\w./-]+\.(?:md|mjs|py|yaml|json)\b/g) ?? []);
  assert.ok(mentioned.size >= 10, `expected many path mentions, found ${mentioned.size}`);
  for (const rel of mentioned) assert.ok(fs.existsSync(path.join(skillDir, rel)), `${rel} is mentioned in SKILL.md but missing`);
  for (const ref of ['plan', 'capture', 'compose', 'deliver']) assert.ok(mentioned.has(`references/${ref}.md`), `SKILL.md must link references/${ref}.md`);
});

test('SKILL.md documents --feature, --tone, --duration, --formats, "150K", "Opus 5.5", "3 iterations", and all three hard gates', () => {
  for (const needle of ['--feature', '--tone', '--duration', '--formats', '150K', 'Opus 5.5', '3 iterations']) {
    assert.ok(skill.includes(needle), `SKILL.md must mention ${needle}`);
  }
  for (const gate of [/origin gate/i, /pii_policy/, /PII scan/i]) assert.match(skill, gate);
  assert.match(skill, /never edit around a gate/i);
});

test('compose.md quotes every TEXT_LIMITS value', () => {
  for (const [tpl, fields] of Object.entries(TEXT_LIMITS)) {
    assert.ok(compose.includes(tpl), `compose.md must list template ${tpl}`);
    for (const [f, n] of Object.entries(fields)) assert.match(compose, new RegExp(`${f}[^\\n]*\\b${n}\\b`), `${tpl}.${f} = ${n}`);
  }
});

test('compose.md documents cue alignment tolerances and the focus coverage warning', () => {
  assert.match(compose, /0\.15 s/);
  assert.match(compose, /0\.10 s/);
  assert.match(compose, /strongCues/);
  assert.match(compose, /tall or narrow focus/);
});

test('files with verbatim brag text end with the attribution line and are listed in THIRD_PARTY_NOTICES.md', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  for (const rel of BRAG_FILES) {
    assert.ok(read(rel).trimEnd().endsWith(ATTRIBUTION), `${rel} must end with the attribution line`);
    assert.ok(notices.includes(`\`${rel}\``), `THIRD_PARTY_NOTICES.md must list ${rel}`);
  }
});

test('example promo.yaml validates with validatePromoConfig', async () => {
  const example = YAML.parse(read('examples', 'personal-website.promo.yaml'));
  const result = await validatePromoConfig(example);
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.ok(example.hide.includes('#contact'), 'the real-email footer/contact hazard stays hidden');
});

test('README has "## Skills" between "## Install" and "## The memory vault" and names both install dirs', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const install = readme.indexOf('\n## Install');
  const skills = readme.indexOf('\n## Skills');
  const vault = readme.indexOf('\n## The memory vault');
  assert.ok(install >= 0 && install < skills && skills < vault, 'section order');
  const section = readme.slice(skills, vault);
  assert.ok(section.includes('~/.claude/skills/promo/') && section.includes('~/.agents/skills/promo/'));
  assert.match(section, /npm ci/);
  assert.match(section, /node scripts\/doctor\.mjs/);
  assert.match(readme, /\*\*`skills\/promo\/`\*\*/);
});
