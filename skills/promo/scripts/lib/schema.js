import fs from 'node:fs';
import Ajv from 'ajv';
import YAML from 'yaml';

export const BEAT_KEYS = ['goto', 'click', 'fill', 'select', 'hover', 'scroll', 'wait', 'settle'];
export const SCENE_TYPES = ['hook', 'title-card', 'feature-callout', 'footage', 'outro'];
export const TRANSITIONS = ['cut', 'dip-to-brand', 'slide', 'none'];

export const ENTRANCE_SECONDS = 0.5; // brag reading-time rule: entrances 0.3-0.6 s
export const TRANSITION_SECONDS = 0.4;
export const MIN_TOTAL = 15;
export const MAX_TOTAL = 30;
export const MIN_FOOTAGE_SHARE = 0.5;

// Plan-chosen and tunable. scenes.schema.json carries the same numbers as maxLength (a test keeps them in step).
export const TEXT_LIMITS = {
  hook: { text: 60 },
  'title-card': { title: 50, sub: 80 },
  'feature-callout': { title: 60, body: 140 },
  outro: { text: 30, sub: 50 },
  footage: { caption: 60 },
};

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Seconds a line must stay fully on screen: max(0.8, 0.3 x words). */
export function readabilityHold(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return round3(Math.max(0.8, 0.3 * words));
}

/** Shortest legal scene: entrance animation plus the longest text hold. */
export function minSceneDuration(scene) {
  const holds = Object.keys(TEXT_LIMITS[scene.type] ?? {})
    .filter((field) => typeof scene[field] === 'string')
    .map((field) => readabilityHold(scene[field]));
  return round3(ENTRANCE_SECONDS + Math.max(0, ...holds));
}

export const sceneDuration = (scene) => (scene.type === 'footage' ? round3(scene.out - scene.in) : scene.duration);
export const totalDuration = (scenes) => round3(scenes.reduce((sum, s) => sum + sceneDuration(s), 0));

export function footageShare(scenes) {
  const total = totalDuration(scenes);
  const footage = scenes.filter((s) => s.type === 'footage').reduce((sum, s) => sum + sceneDuration(s), 0);
  return total === 0 ? 0 : footage / total;
}

export const formatErrors = (errors) => errors.map((e) => `${e.path || '/'}: ${e.message}`).join('\n');

export class ValidationError extends Error {
  constructor(errors) {
    super(formatErrors(errors));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const readSchema = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
const promoSchema = ajv.compile(readSchema('./promo.schema.json'));
const scenesSchema = ajv.compile(readSchema('./scenes.schema.json'));

const escapePointer = (s) => String(s).replaceAll('~', '~0').replaceAll('/', '~1');

function toErrors(ajvErrors) {
  return ajvErrors
    .filter((e) => e.keyword !== 'if') // "must match then schema" duplicates the real errors below it
    .map((e) => {
      let message = e.message;
      let path = e.instancePath;
      if (e.keyword === 'required') path += `/${escapePointer(e.params.missingProperty)}`;
      if (e.keyword === 'additionalProperties') message = `must NOT have additional property '${e.params.additionalProperty}'`;
      if (e.keyword === 'enum') message += `: ${e.params.allowedValues.join(', ')}`;
      return { path, message };
    });
}

const result = (errors) => ({ ok: errors.length === 0, errors });

function stagingUrlProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'must be an absolute http(s) URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'must use http or https';
  if (parsed.username || parsed.password) return 'must not contain credentials';
  return null;
}

/** The one origin capture may touch. */
export function stagingOrigin(url) {
  const problem = stagingUrlProblem(url);
  if (problem) throw new ValidationError([{ path: '/staging/url', message: problem }]);
  return new URL(url).origin;
}

export function validatePromoConfig(obj) {
  if (!promoSchema(obj)) return result(toErrors(promoSchema.errors));
  const errors = [];
  const urlProblem = stagingUrlProblem(obj.staging.url);
  if (urlProblem) errors.push({ path: '/staging/url', message: urlProblem });
  const seen = new Set();
  obj.flows.forEach((flow, i) => {
    if (seen.has(flow.name)) errors.push({ path: `/flows/${i}/name`, message: `duplicate flow name '${flow.name}'` });
    seen.add(flow.name);
  });
  return result(errors);
}

export function validateScenes(obj, ctx = {}) {
  if (!scenesSchema(obj)) return result(toErrors(scenesSchema.errors));
  const errors = [];
  const { scenes } = obj;
  const { flowDurations } = ctx;

  scenes.forEach((scene, i) => {
    const at = `/scenes/${i}`;
    const min = minSceneDuration(scene);
    if (scene.type === 'footage') {
      if (scene.out <= scene.in) {
        errors.push({ path: `${at}/out`, message: `must be greater than in (${scene.in})` });
      } else if (sceneDuration(scene) < min) {
        errors.push({ path: `${at}/out`, message: `footage runs ${sceneDuration(scene)} s but its caption needs at least ${min} s` });
      }
      if (flowDurations) {
        if (!Object.hasOwn(flowDurations, scene.flow)) {
          errors.push({ path: `${at}/flow`, message: `unknown flow '${scene.flow}'` });
        } else if (scene.out > flowDurations[scene.flow]) {
          errors.push({ path: `${at}/out`, message: `beyond the ${flowDurations[scene.flow]} s recording of '${scene.flow}'` });
        }
      }
    } else if (scene.duration < min) {
      errors.push({ path: `${at}/duration`, message: `must be at least ${min} s to read its text` });
    }
  });

  const last = scenes.length - 1;
  if (scenes[last].transition !== 'none') {
    errors.push({ path: `/scenes/${last}/transition`, message: "the last scene must use transition 'none'" });
  }

  const total = totalDuration(scenes);
  if (total < MIN_TOTAL || total > MAX_TOTAL) {
    errors.push({ path: '/scenes', message: `total duration ${total} s must be between ${MIN_TOTAL} and ${MAX_TOTAL} s` });
  }
  const share = footageShare(scenes);
  if (share < MIN_FOOTAGE_SHARE) {
    errors.push({ path: '/scenes', message: `footage is ${Math.round(share * 100)}% of the runtime; at least ${MIN_FOOTAGE_SHARE * 100}% is required` });
  }
  return result(errors);
}

async function loadAndValidate(file, parse, validate) {
  let data;
  try {
    data = parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    throw new ValidationError([{ path: '', message: `cannot parse ${file}: ${err.message}` }]);
  }
  const { ok, errors } = validate(data);
  if (!ok) throw new ValidationError(errors);
  return data;
}

export const loadPromoConfig = (file) => loadAndValidate(file, YAML.parse, validatePromoConfig);
export const loadScenes = (file, ctx) => loadAndValidate(file, JSON.parse, (obj) => validateScenes(obj, ctx));
