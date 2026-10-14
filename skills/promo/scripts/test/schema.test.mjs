import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  BEAT_KEYS, SCENE_TYPES, TRANSITIONS, ENTRANCE_SECONDS, TRANSITION_SECONDS,
  MIN_TOTAL, MAX_TOTAL, MIN_FOOTAGE_SHARE, TEXT_LIMITS,
  readabilityHold, minSceneDuration, sceneDuration, totalDuration, footageShare,
  ValidationError, formatErrors,
  validatePromoConfig, loadPromoConfig, stagingOrigin,
  validateScenes, loadScenes,
} from '../lib/schema.js';

const fileURL = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const valid = JSON.parse(fs.readFileSync(fileURL('valid-scenes.json'), 'utf8'));
const validPromo = YAML.parse(fs.readFileSync(fileURL('valid-promo.yaml'), 'utf8'));
const FLOWS = { flowDurations: { 'rent-collection': 20 } };

const paths = (r) => r.errors.map((e) => e.path);
const clone = (o) => structuredClone(o);

test('constants', () => {
  assert.deepEqual(BEAT_KEYS, ['goto', 'click', 'fill', 'select', 'hover', 'scroll', 'wait', 'settle']);
  assert.deepEqual(SCENE_TYPES, ['hook', 'title-card', 'feature-callout', 'footage', 'outro']);
  assert.deepEqual(TRANSITIONS, ['cut', 'dip-to-brand', 'slide', 'none']);
  assert.equal(ENTRANCE_SECONDS, 0.5);
  assert.equal(TRANSITION_SECONDS, 0.4);
  assert.equal(MIN_TOTAL, 15);
  assert.equal(MAX_TOTAL, 30);
  assert.equal(MIN_FOOTAGE_SHARE, 0.5);
  assert.deepEqual(TEXT_LIMITS, {
    hook: { text: 60 },
    'title-card': { title: 50, sub: 80 },
    'feature-callout': { title: 60, body: 140 },
    outro: { text: 30, sub: 50 },
    footage: { caption: 60 },
  });
});

test('readabilityHold', () => {
  assert.equal(readabilityHold('Hi'), 0.8);
  assert.equal(readabilityHold('one two three'), 0.9);
  assert.equal(readabilityHold('Rent day, without the chasing.'), 1.5);
  assert.equal(readabilityHold('Record a payment in one tap'), 1.8);
  assert.equal(readabilityHold('  spaced   out  '), 0.8);
});

test('minSceneDuration = entrance + longest hold', () => {
  assert.equal(minSceneDuration({ type: 'hook', text: 'Rent day, without the chasing.' }), 2.0);
  assert.equal(minSceneDuration({ type: 'footage', caption: 'Record a payment in one tap' }), 2.3);
  assert.equal(
    minSceneDuration({ type: 'title-card', title: 'Hi', sub: 'one two three four five six' }),
    0.5 + 1.8,
  );
});

test('sceneDuration, totalDuration, footageShare', () => {
  assert.equal(sceneDuration(valid.scenes[0]), 2.5);
  assert.equal(sceneDuration(valid.scenes[1]), 11);
  assert.equal(totalDuration(valid.scenes), 19.5);
  assert.ok(footageShare(valid.scenes) >= 0.5);
});

test('TEXT_LIMITS match the maxLength values in scenes.schema.json', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../lib/scenes.schema.json', import.meta.url), 'utf8'));
  const defs = schema.$defs;
  const byType = {
    hook: defs.hook, 'title-card': defs.titleCard, 'feature-callout': defs.featureCallout,
    outro: defs.outro, footage: defs.footage,
  };
  for (const [type, limits] of Object.entries(TEXT_LIMITS)) {
    for (const [field, max] of Object.entries(limits)) {
      assert.equal(byType[type].properties[field].maxLength, max, `${type}.${field}`);
    }
  }
});

test('beat keys in promo.schema.json match BEAT_KEYS', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../lib/promo.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.$defs.beat.properties), BEAT_KEYS);
});

test('valid scenes pass with flowDurations', () => {
  const r = validateScenes(valid, FLOWS);
  assert.equal(r.ok, true, formatErrors(r.errors));
  assert.deepEqual(r.errors, []);
});

test('valid scenes pass without flowDurations', () => {
  const r = validateScenes(valid);
  assert.equal(r.ok, true, formatErrors(r.errors));
});

const withScenes = ({ hook = 2.5, footage = 11, callout = 3, outro = 3 } = {}) => {
  const o = clone(valid);
  o.scenes[0].duration = hook;
  o.scenes[1].in = 0;
  o.scenes[1].out = footage;
  o.scenes[2].duration = callout;
  o.scenes[3].duration = outro;
  return o;
};

const invalidScenes = [
  ['total 14.9 s', () => withScenes({ hook: 2.0, footage: 8.0, callout: 2.4, outro: 2.5 }), '/scenes'],
  ['total 30.1 s', () => withScenes({ footage: 21.6 }), '/scenes'],
  ['footage share below 0.5', () => withScenes({ footage: 8.0 }), '/scenes'],
  ['footage without caption', () => { const o = clone(valid); delete o.scenes[1].caption; return o; }, '/scenes/1/caption'],
  ['crossfade transition', () => { const o = clone(valid); o.scenes[0].transition = 'crossfade'; return o; }, '/scenes/0/transition'],
  ["unknown type 'montage'", () => { const o = clone(valid); o.scenes[0].type = 'montage'; return o; }, '/scenes/0/type'],
  ['fps 60', () => { const o = clone(valid); o.fps = 60; return o; }, '/fps'],
  ['master 1280x720', () => { const o = clone(valid); o.master = { w: 1280, h: 720 }; return o; }, '/master'],
  ['hook text of 61 chars', () => { const o = clone(valid); o.scenes[0].text = 'x'.repeat(61); return o; }, '/scenes/0/text'],
  ['hook duration 1.9 for a 5-word text', () => { const o = clone(valid); o.scenes[0].duration = 1.9; return o; }, '/scenes/0/duration'],
  ['footage with a duration key', () => { const o = clone(valid); o.scenes[1].duration = 5; return o; }, '/scenes/1'],
  ['footage out <= in', () => { const o = clone(valid); o.scenes[1].out = 3.2; return o; }, '/scenes/1/out'],
  ['footage shorter than its caption needs', () => withScenes({ footage: 2.0 }), '/scenes/1/out'],
  ['out beyond the flow duration', () => { const o = clone(valid); o.scenes[1].out = 20.5; return o; }, '/scenes/1/out'],
  ['unknown flow', () => { const o = clone(valid); o.scenes[1].flow = 'nope'; return o; }, '/scenes/1/flow'],
  ['last scene transition dip-to-brand', () => { const o = clone(valid); o.scenes[3].transition = 'dip-to-brand'; return o; }, '/scenes/3/transition'],
  ['footage focus with negative w', () => { const o = clone(valid); o.scenes[1].focus.w = -1; return o; }, '/scenes/1/focus/w'],
  ['brand colour not #RRGGBB', () => { const o = clone(valid); o.brand.primary = '#0F7'; return o; }, '/brand/primary'],
];

for (const [name, make, expected] of invalidScenes) {
  test(`invalid scenes: ${name} -> ${expected}`, () => {
    const r = validateScenes(make(), FLOWS);
    assert.equal(r.ok, false);
    assert.ok(paths(r).includes(expected), `${expected} not in ${JSON.stringify(r.errors)}`);
  });
}

test('formatErrors prints one "path: message" per line', () => {
  const text = formatErrors([
    { path: '/flows/0/beats/2/wait', message: 'must be <= 3000' },
    { path: '', message: 'bad root' },
  ]);
  assert.equal(text, '/flows/0/beats/2/wait: must be <= 3000\n/: bad root');
});

test('loadScenes parses a file and throws ValidationError with field paths', async (t) => {
  assert.deepEqual(await loadScenes(fileURL('valid-scenes.json'), FLOWS), valid);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'scenes.json');
  fs.writeFileSync(bad, JSON.stringify({ ...valid, fps: 60 }));
  await assert.rejects(loadScenes(bad), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.deepEqual(e.errors.map((x) => x.path), ['/fps']);
    assert.match(e.message, /^\/fps: /);
    return true;
  });

  const garbled = path.join(dir, 'garbled.json');
  fs.writeFileSync(garbled, '{ not json');
  await assert.rejects(loadScenes(garbled), ValidationError);
});

test('promo.yaml: valid sample from spec 3.2 passes', async () => {
  const r = validatePromoConfig(validPromo);
  assert.equal(r.ok, true, formatErrors(r.errors));
  const loaded = await loadPromoConfig(fileURL('valid-promo.yaml'));
  assert.deepEqual(loaded, validPromo);
});

test('promo.yaml: pii_policy is required', () => {
  const o = clone(validPromo);
  delete o.pii_policy;
  const r = validatePromoConfig(o);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === '/pii_policy'));
});

const withBeat = (beat) => {
  const o = clone(validPromo);
  o.flows[0].beats[2] = beat;
  return o;
};

test('beats: wait 3000 ok, 3001 rejected', () => {
  assert.equal(validatePromoConfig(withBeat({ wait: 3000 })).ok, true);
  const r = validatePromoConfig(withBeat({ wait: 3001 }));
  assert.equal(r.ok, false);
  assert.ok(paths(r).includes('/flows/0/beats/2/wait'));
});

test('beats: unknown beat {drag} and two keys in one beat are rejected', () => {
  const drag = validatePromoConfig(withBeat({ drag: '#a' }));
  assert.equal(drag.ok, false);
  assert.ok(paths(drag).includes('/flows/0/beats/2'));
  const two = validatePromoConfig(withBeat({ click: '#a', hover: '#b' }));
  assert.equal(two.ok, false);
  assert.ok(paths(two).includes('/flows/0/beats/2'));
  const empty = validatePromoConfig(withBeat({}));
  assert.ok(paths(empty).includes('/flows/0/beats/2'));
});

test('beats: fill and select need both fields', () => {
  assert.ok(paths(validatePromoConfig(withBeat({ fill: { selector: '#a' } }))).includes('/flows/0/beats/2/fill/text'));
  assert.ok(paths(validatePromoConfig(withBeat({ select: { selector: '#a' } }))).includes('/flows/0/beats/2/select/value'));
});

test('staging.url: localhost ok and stagingOrigin() returns the origin', () => {
  const o = clone(validPromo);
  o.staging.url = 'http://localhost:3000';
  assert.equal(validatePromoConfig(o).ok, true);
  assert.equal(stagingOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(stagingOrigin('https://staging.rpms.example/some/path?q=1'), 'https://staging.rpms.example');
});

test('staging.url: ftp:// and urls with credentials are rejected', () => {
  for (const url of ['ftp://staging.rpms.example', 'https://user:pw@staging.rpms.example', 'not a url']) {
    const o = clone(validPromo);
    o.staging.url = url;
    const r = validatePromoConfig(o);
    assert.equal(r.ok, false, url);
    assert.ok(paths(r).includes('/staging/url'), url);
    assert.throws(() => stagingOrigin(url), ValidationError, url);
  }
});

test('duplicate flow names are rejected; names must match ^[a-z0-9][a-z0-9-]*$', () => {
  const dup = clone(validPromo);
  dup.flows[1].name = dup.flows[0].name;
  const r = validatePromoConfig(dup);
  assert.equal(r.ok, false);
  assert.ok(paths(r).includes('/flows/1/name'));

  for (const name of ['Tenant', '-lead', 'has space', 'a/b', '']) {
    const o = clone(validPromo);
    o.flows[0].name = name;
    const bad = validatePromoConfig(o);
    assert.ok(paths(bad).includes('/flows/0/name'), JSON.stringify(name));
  }
});

test('login env names must match ^[A-Z_][A-Z0-9_]*$; hex colours must be #RRGGBB', () => {
  const env = clone(validPromo);
  env.staging.login.user_env = 'rpms_demo_user';
  assert.ok(paths(validatePromoConfig(env)).includes('/staging/login/user_env'));
  const pass = clone(validPromo);
  pass.staging.login.pass_env = '1PASS';
  assert.ok(paths(validatePromoConfig(pass)).includes('/staging/login/pass_env'));

  const colour = clone(validPromo);
  colour.brand.accent = 'orange';
  assert.ok(paths(validatePromoConfig(colour)).includes('/brand/accent'));
  const short = clone(validPromo);
  short.brand.primary = '#0F7';
  assert.ok(paths(validatePromoConfig(short)).includes('/brand/primary'));
});

test('promo.yaml: unknown top-level keys are rejected', () => {
  const o = clone(validPromo);
  o.piipolicy = 'x';
  const r = validatePromoConfig(o);
  assert.equal(r.ok, false);
  assert.ok(paths(r).includes(''));
});

test('loadPromoConfig throws ValidationError for an invalid file and for broken yaml', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'promo.yaml');
  const o = clone(validPromo);
  delete o.pii_policy;
  fs.writeFileSync(bad, YAML.stringify(o));
  await assert.rejects(loadPromoConfig(bad), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.deepEqual(e.errors.map((x) => x.path), ['/pii_policy']);
    return true;
  });

  const broken = path.join(dir, 'broken.yaml');
  fs.writeFileSync(broken, 'a: [unclosed');
  await assert.rejects(loadPromoConfig(broken), ValidationError);
});
