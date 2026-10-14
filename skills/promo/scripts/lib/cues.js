// Precomputed beat/cue JSON next to each music track. The runtime only reads it; a maintainer tool
// (Task 11) produces it. Tolerances follow the reference audio notes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAJOR_TOL = 0.15;
export const MINOR_TOL = 0.10;

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MUSIC_DIR = path.resolve(here, '..', '..', 'assets', 'music');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(file, field, why) {
  throw new Error(`invalid cues file ${file}: ${field} ${why}`);
}

/** Read and validate a cues file. Extra keys are allowed; a missing or mistyped required field is named. */
export async function loadCues(file) {
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read cues file ${file}: ${e.message}`);
  }
  if (!isObj(data)) fail(file, 'the document', 'must be a JSON object');
  if (!isNum(data.schemaVersion)) fail(file, 'schemaVersion', 'must be a number');
  if (!isObj(data.source)) fail(file, 'source', 'must be an object');
  if (typeof data.source.filename !== 'string') fail(file, 'source.filename', 'must be a string');
  if (typeof data.source.trackStem !== 'string') fail(file, 'source.trackStem', 'must be a string');
  if (!isNum(data.duration)) fail(file, 'duration', 'must be a number');
  if (!isNum(data.tempo)) fail(file, 'tempo', 'must be a number');
  if (!Array.isArray(data.beats)) fail(file, 'beats', 'must be an array');
  if (!Array.isArray(data.strongCues)) fail(file, 'strongCues', 'must be an array');
  data.strongCues.forEach((c, i) => {
    if (!isObj(c) || !isNum(c.time)) fail(file, `strongCues[${i}].time`, 'must be a number');
  });
  return { tempo: data.tempo, duration: data.duration, strongCues: data.strongCues };
}

/** The strong cue closest to t, with delta = cue.time - t; null when there are no cues. */
export function nearestCue(cues, t) {
  let best = null;
  for (const cue of cues.strongCues) {
    const delta = cue.time - t;
    if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { time: cue.time, delta };
  }
  return best;
}

/** How near each boundary sits to a strong cue. Report only: a miss never fails a render. */
export function alignmentReport(boundaries, cues, tol = MAJOR_TOL) {
  return boundaries.map((t) => {
    const near = nearestCue(cues, t);
    if (!near) return { t, nearest: null, delta: null, within: false };
    return { t, nearest: near.time, delta: near.delta, within: Math.abs(near.delta) <= tol + 1e-9 };
  });
}

/** Locate a track's audio file and its cues file: <musicDir>/<track>.mp3 (else .wav) and <track>.cues.json. */
export function resolveTrack(track, { musicDir } = {}) {
  if (typeof track !== 'string' || track === '' || /[\\/]|\.\./.test(track)) {
    throw new Error(`music track "${track}" must be a plain track name, not a path`);
  }
  const dir = musicDir ?? process.env.PROMO_MUSIC_DIR ?? DEFAULT_MUSIC_DIR;
  const audio = ['.mp3', '.wav'].map((ext) => path.join(dir, `${track}${ext}`)).find((f) => fs.existsSync(f));
  if (!audio) throw new Error(`music track "${track}" not found: no ${path.join(dir, `${track}.mp3`)} or ${path.join(dir, `${track}.wav`)}`);
  const cues = path.join(dir, `${track}.cues.json`);
  if (!fs.existsSync(cues)) throw new Error(`music track "${track}" has no cues file: ${cues}`);
  return { audio, cues };
}
