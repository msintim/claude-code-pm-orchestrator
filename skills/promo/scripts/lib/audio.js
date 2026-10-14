// Music mix: gain, ducking under footage, fade-out. Pure filter-string maths; the caller runs ffmpeg.
// The envelope is evaluated per audio frame by ffmpeg (volume=...:eval=frame), so ducking ramps
// instead of stepping, which would click.

export const DEFAULT_GAIN_DB = -14;
export const DEFAULT_DUCK_DB = -6;
export const RAMP_SEC = 0.15;
export const FADE_OUT_SEC = 0.3;

const EPS = 1e-6;
const num = (n) => Number(n.toFixed(4));

/** The time spans where footage is on screen, with touching or overlapping spans merged. */
export function duckIntervals(timeline, scenes) {
  const spans = timeline.scenes
    .filter((s) => scenes[s.index].type === 'footage')
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + EPS) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Duck depth in dB at time t: 0 outside, `duckDb` inside, linear ramps of `rampSec` either side of each interval. */
export function envelopeDb(t, intervals, duckDb, rampSec = RAMP_SEC) {
  let weight = 0;
  for (const { start, end } of intervals) {
    const w = Math.min((t - (start - rampSec)) / rampSec, ((end + rampSec) - t) / rampSec);
    weight = Math.max(weight, Math.min(Math.max(w, 0), 1));
  }
  const v = Math.round(duckDb * weight * 1e9) / 1e9;
  return v === 0 ? 0 : v;
}

/** The ffmpeg expression (variable `t`) for the same trapezoid envelope as envelopeDb, as a 0..1 weight. */
function weightExpr(intervals, rampSec) {
  const terms = intervals.map(({ start, end }) => (
    `clip(min((t-${num(start - rampSec)})/${rampSec},(${num(end + rampSec)}-t)/${rampSec}),0,1)`
  ));
  return terms.reduce((acc, term) => `max(${acc},${term})`);
}

/**
 * Audio filter chain for the music input: static gain, the ducking envelope, then a fade-out that ends
 * exactly at the video's end. The caller wraps it: `[1:a]<filter>[a]`.
 */
export function buildAudioFilter({ gainDb, duckDb, intervals, total, fadeOutSec = FADE_OUT_SEC, rampSec = RAMP_SEC }) {
  const parts = [`volume=${gainDb}dB`];
  if (intervals.length > 0 && duckDb !== 0) {
    parts.push(`volume='pow(10,${duckDb}*(${weightExpr(intervals, rampSec)})/20)':eval=frame`);
  }
  parts.push(`afade=t=out:st=${num(Math.max(total - fadeOutSec, 0))}:d=${fadeOutSec}`);
  return parts.join(',');
}
