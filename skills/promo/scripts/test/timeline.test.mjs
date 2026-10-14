import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, at, stillTimes } from '../lib/timeline.js';
import { ENTRANCE_SECONDS, TRANSITION_SECONDS, minSceneDuration, TEXT_LIMITS } from '../lib/schema.js';

const { equal, deepEqual } = assert;
const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

const scenes = [
  { type: 'hook', duration: 2.5, text: 'a', transition: 'dip-to-brand' },
  { type: 'footage', flow: 'f', in: 1, out: 12, caption: 'c', transition: 'cut' },
  { type: 'feature-callout', duration: 3, title: 't', body: 'b', transition: 'slide' },
  { type: 'outro', duration: 3, text: 'o', transition: 'none' },
];
const tl = buildTimeline(scenes);

test('totals and starts', () => {
  equal(tl.total, 19.5);
  equal(tl.frameCount, 585);
  deepEqual(tl.scenes.map((s) => s.start), [0, 2.5, 13.5, 16.5]);
  deepEqual(tl.scenes.map((s) => s.duration), [2.5, 11, 3, 3]);
});

test('frameCount follows fps', () => equal(buildTimeline(scenes, 60).frameCount, 1170));

test('transition window around a dip boundary', () => {
  equal(at(tl, 2.5).transition.kind, 'dip-to-brand');
  approx(at(tl, 2.5).transition.progress, 0.5);
  equal(at(tl, 2.5).transition.boundary, 2.5);
  equal(at(tl, 2.0).transition, undefined);
  approx(at(tl, 2.5 - TRANSITION_SECONDS / 2).transition.progress, 0);
  approx(at(tl, 2.5 + TRANSITION_SECONDS / 2).transition.progress, 1);
  equal(at(tl, 2.5 + TRANSITION_SECONDS / 2 + 0.01).transition, undefined);
});

test('outgoing localT clamps to its duration, incoming clamps to 0', () => {
  const before = at(tl, 2.4);
  equal(before.outgoing.index, 0);
  approx(before.outgoing.localT, 2.4);
  equal(before.incoming.index, 1);
  equal(before.incoming.localT, 0);
  const after = at(tl, 2.6);
  equal(after.outgoing.index, 0);
  approx(after.outgoing.localT, 2.5);
  equal(after.incoming.index, 1);
  approx(after.incoming.localT, 0.1);
});

test('cut and none have no window', () => {
  equal(at(tl, 13.5).transition, undefined);
  equal(at(tl, 13.5).incoming, undefined);
  equal(at(tl, 13.5).outgoing.index, 2);
  equal(at(tl, 13.5).outgoing.localT, 0);
  equal(at(tl, 12).outgoing.index, 1);
});

test('slide window sits on the slide boundary; the end of the film stays on the last scene', () => {
  equal(at(tl, 16.5).transition.kind, 'slide');
  const end = at(tl, 19.5);
  equal(end.outgoing.index, 3);
  approx(end.outgoing.localT, 3);
  equal(at(tl, 25).outgoing.index, 3);
});

test('stillTimes: scene mids plus non-cut transition mids with stable names, in time order', () => {
  const stills = stillTimes(tl);
  deepEqual(stills.map((s) => s.name), [
    'scene-01-mid', 'transition-01-02-mid', 'scene-02-mid', 'scene-03-mid', 'transition-03-04-mid', 'scene-04-mid',
  ]);
  deepEqual(stills.map((s) => s.t), [1.25, 2.5, 8, 15, 16.5, 18]);
  deepEqual(stills.map((s) => s.kind), ['scene', 'transition', 'scene', 'scene', 'transition', 'scene']);
  deepEqual(stills.map((s) => s.index), [0, 0, 1, 2, 2, 3]);
});

test('every scene midpoint is after the entrance for the shortest schema-valid scene', () => {
  const texts = { hook: 'a', 'title-card': 'a', 'feature-callout': 'a', outro: 'a' };
  for (const type of Object.keys(texts)) {
    const scene = { type };
    for (const f of Object.keys(TEXT_LIMITS[type])) scene[f] = 'word';
    const d = minSceneDuration(scene);
    assert.ok(d / 2 >= ENTRANCE_SECONDS, `${type}: ${d / 2} < ${ENTRANCE_SECONDS}`);
  }
});

test('the isomorphic timeline keeps its own transition constant in step with the schema', async () => {
  const { TRANSITION_SECONDS: local } = await import('../lib/timeline.js');
  equal(local, TRANSITION_SECONDS);
});
