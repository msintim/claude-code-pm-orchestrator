import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCues, attributionFor } from '../lib/cues.js';
import { tmpDir, scriptsDir } from './helpers.mjs';

const SAMPLE = path.join(scriptsDir, 'test', 'fixtures', 'sample.cues.json');
const MUSIC_DIR = path.resolve(scriptsDir, '..', 'assets', 'music');
const TABLE_HEAD = '| track | title | author | source URL | licence | retrieved |\n| --- | --- | --- | --- | --- | --- |\n';

test('the tool-produced sample cue file loads', async () => {
  const cues = await loadCues(SAMPLE);
  assert.ok(cues.strongCues.length > 0);
  const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.deepEqual(Object.keys(raw), ['schemaVersion', 'source', 'duration', 'tempo', 'analysis', 'scoring', 'beats', 'strongCues']);
  for (const cue of raw.strongCues) assert.ok(['strong_beat', 'onset_peak'].includes(cue.kind), cue.kind);
});

test('every bundled mp3 has a valid cues.json and a LICENSES.md row with licence CC-BY-4.0 or CC0, an https URL and an ISO date', async (t) => {
  const mp3s = fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith('.mp3'));
  if (mp3s.length === 0) t.diagnostic('TODO: no bundled mp3 yet (Task 11 step 6); the per-track assertions pass vacuously');
  const rows = fs.readFileSync(path.join(MUSIC_DIR, 'LICENSES.md'), 'utf8').split('\n').filter((l) => /^\|/.test(l));
  for (const file of mp3s) {
    const stem = file.replace(/\.mp3$/, '');
    assert.ok((await loadCues(path.join(MUSIC_DIR, `${stem}.cues.json`))).strongCues.length > 0, `${stem} cues`);
    const row = rows.map((l) => l.split('|').slice(1, -1).map((c) => c.trim())).find((cells) => cells[0] === stem);
    assert.ok(row, `LICENSES.md has a row for ${stem}`);
    const [, title, author, url, licence, retrieved] = row;
    assert.ok(title && author, `${stem} title and author`);
    assert.match(url, /^https:\/\//);
    assert.match(licence, /^(CC-BY-4\.0|CC0)$/);
    assert.match(retrieved, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('attributionFor returns a CC-BY credit line and null for CC0', async () => {
  const musicDir = tmpDir('music-licences');
  fs.writeFileSync(path.join(musicDir, 'LICENSES.md'), `# Licences\n\n${TABLE_HEAD}`
    + '| happy-beats | Happy Beats & Business Moves, Vol. 1 | Sascha Ende | https://ende.app/en/song/12866-happy-beats-business-moves-vol-1 | CC-BY-4.0 | 2026-10-14 |\n'
    + '| quiet-pad | Quiet Pad | Someone Else | https://example.org/quiet-pad | CC0 | 2026-10-14 |\n');
  assert.equal(
    await attributionFor('happy-beats', { musicDir }),
    'Music: "Happy Beats & Business Moves, Vol. 1" by Sascha Ende (https://ende.app/en/song/12866-happy-beats-business-moves-vol-1), CC BY 4.0 https://creativecommons.org/licenses/by/4.0/, edited',
  );
  assert.equal(await attributionFor('quiet-pad', { musicDir }), null);
});

test('attributionFor refuses a track with no licence row and a path-like name, and skips an untracked directory', async () => {
  const musicDir = tmpDir('music-licences-missing');
  fs.writeFileSync(path.join(musicDir, 'LICENSES.md'), TABLE_HEAD);
  await assert.rejects(() => attributionFor('ghost', { musicDir }), /no row for "ghost"/);
  await assert.rejects(() => attributionFor('../ghost', { musicDir }), /plain track name/);
  // A directory with no LICENSES.md is a user-supplied one: nothing is tracked there, so nothing is credited.
  assert.equal(await attributionFor('ghost', { musicDir: tmpDir('music-no-file') }), null);
});
