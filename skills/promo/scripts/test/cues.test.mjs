import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadCues, nearestCue, alignmentReport, resolveTrack, MAJOR_TOL, MINOR_TOL,
} from '../lib/cues.js';
import { tmpDir, scriptsDir } from './helpers.mjs';

const valid = path.join(scriptsDir, 'test', 'fixtures', 'valid.cues.json');
const cuesAt = (...times) => ({ tempo: 120, duration: 30, strongCues: times.map((time) => ({ time })) });

test('tolerances', () => {
  assert.equal(MAJOR_TOL, 0.15);
  assert.equal(MINOR_TOL, 0.10);
});

test('loadCues accepts brag-shaped JSON incl. extra keys', async () => {
  const cues = await loadCues(valid);
  assert.equal(cues.tempo, 120);
  assert.equal(cues.duration, 30);
  assert.deepEqual(cues.strongCues.map((c) => c.time), [0.5, 2.5, 8]);
  assert.equal(cues.strongCues[0].kind, 'downbeat');
});

test('loadCues names the missing field', async () => {
  const doc = JSON.parse(fs.readFileSync(valid, 'utf8'));
  delete doc.strongCues;
  const file = path.join(tmpDir('cues-bad'), 'bad.cues.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(loadCues(file), /strongCues/);
});

test('loadCues names a cue without a numeric time, and an unreadable file', async () => {
  const doc = JSON.parse(fs.readFileSync(valid, 'utf8'));
  doc.strongCues[1] = { time: 'soon' };
  const dir = tmpDir('cues-bad2');
  fs.writeFileSync(path.join(dir, 'bad.cues.json'), JSON.stringify(doc));
  await assert.rejects(loadCues(path.join(dir, 'bad.cues.json')), /strongCues\[1\]\.time/);
  await assert.rejects(loadCues(path.join(dir, 'missing.cues.json')), /missing\.cues\.json/);
});

test('nearestCue / alignmentReport honour tolerance 0.15: boundary 2.5 with cue 2.4 -> within true; cue 2.3 -> within false', () => {
  assert.deepEqual(nearestCue(cuesAt(1, 2.4, 9), 2.5).time, 2.4);
  assert.equal(nearestCue(cuesAt(), 2.5), null);
  const [near] = alignmentReport([2.5], cuesAt(2.4));
  assert.equal(near.within, true);
  assert.equal(near.nearest, 2.4);
  assert.ok(Math.abs(near.delta - -0.1) < 1e-9);
  const [far] = alignmentReport([2.5], cuesAt(2.3));
  assert.equal(far.within, false);
  assert.deepEqual(alignmentReport([2.5], cuesAt()), [{ t: 2.5, nearest: null, delta: null, within: false }]);
  assert.equal(alignmentReport([2.5], cuesAt(2.3), 0.25)[0].within, true);
});

test('resolveTrack honours PROMO_MUSIC_DIR, prefers mp3, and names the missing file', () => {
  const dir = tmpDir('music-dir');
  fs.writeFileSync(path.join(dir, 'a.wav'), '');
  fs.writeFileSync(path.join(dir, 'a.cues.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.mp3'), '');
  fs.writeFileSync(path.join(dir, 'b.wav'), '');
  fs.writeFileSync(path.join(dir, 'b.cues.json'), '{}');
  const saved = process.env.PROMO_MUSIC_DIR;
  process.env.PROMO_MUSIC_DIR = dir;
  try {
    assert.deepEqual(resolveTrack('a'), { audio: path.join(dir, 'a.wav'), cues: path.join(dir, 'a.cues.json') });
    assert.equal(resolveTrack('b').audio, path.join(dir, 'b.mp3'));
    assert.throws(() => resolveTrack('nope'), (e) => e.message.includes(path.join(dir, 'nope.mp3')));
    assert.deepEqual(resolveTrack('a', { musicDir: dir }).audio, path.join(dir, 'a.wav'));
    assert.throws(() => resolveTrack('../a'), /plain track name/);
    fs.rmSync(path.join(dir, 'a.cues.json'));
    assert.throws(() => resolveTrack('a'), /a\.cues\.json/);
  } finally {
    if (saved === undefined) delete process.env.PROMO_MUSIC_DIR;
    else process.env.PROMO_MUSIC_DIR = saved;
  }
});
