// Pure timeline arithmetic. Isomorphic: no imports, so the browser compositor can use it unchanged.
// schema.js is Node-only (fs, ajv), so the one constant it shares is repeated here and a test keeps them in step.

export const TRANSITION_SECONDS = 0.4;

const WINDOWED = new Set(['dip-to-brand', 'slide']);
const round3 = (n) => Math.round(n * 1000) / 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const durationOf = (scene) => (scene.type === 'footage' ? round3(scene.out - scene.in) : scene.duration);

export function buildTimeline(scenes, fps = 30) {
  let cursor = 0;
  const entries = scenes.map((scene, index) => {
    const duration = durationOf(scene);
    const start = round3(cursor);
    cursor += duration;
    return { index, start, end: round3(cursor), duration, transition: scene.transition };
  });
  const total = round3(cursor);
  return { total, frameCount: Math.round(total * fps), fps, scenes: entries };
}

/**
 * What is on screen at time t. Outside a transition window only `outgoing` is set (the scene
 * containing t). Inside one, `outgoing` is the scene that is ending (its localT clamps to its
 * duration) and `incoming` the next one (its localT clamps to 0).
 */
export function at(timeline, t) {
  const { scenes } = timeline;
  const half = TRANSITION_SECONDS / 2;
  for (let i = 0; i < scenes.length - 1; i += 1) {
    const s = scenes[i];
    if (!WINDOWED.has(s.transition)) continue;
    if (t >= s.end - half && t <= s.end + half) {
      return {
        outgoing: { index: i, localT: Math.min(Math.max(t - s.start, 0), s.duration) },
        incoming: { index: i + 1, localT: Math.max(t - s.end, 0) },
        transition: { kind: s.transition, progress: (t - (s.end - half)) / TRANSITION_SECONDS, boundary: s.end },
      };
    }
  }
  let index = scenes.findIndex((s) => t < s.end);
  if (index === -1) index = scenes.length - 1;
  const s = scenes[index];
  return { outgoing: { index, localT: Math.min(Math.max(t - s.start, 0), s.duration) } };
}

/** The review frames: every scene's midpoint and every windowed transition's midpoint, in time order. */
export function stillTimes(timeline) {
  const { scenes } = timeline;
  const stills = [];
  scenes.forEach((s, i) => {
    stills.push({ kind: 'scene', index: i, t: round3(s.start + s.duration / 2), name: `scene-${pad2(i + 1)}-mid` });
    if (i < scenes.length - 1 && WINDOWED.has(s.transition)) {
      stills.push({ kind: 'transition', index: i, t: s.end, name: `transition-${pad2(i + 1)}-${pad2(i + 2)}-mid` });
    }
  });
  return stills.sort((a, b) => a.t - b.t || (a.kind === 'scene' ? -1 : 1));
}
