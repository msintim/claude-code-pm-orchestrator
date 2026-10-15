// Loop-point selection for the hero loop: find the start and end frames whose surroundings are quietest, so
// the seam where the clip wraps around hides in a stretch where nothing moves.

export class NoLoopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoLoopError';
  }
}

/** Mean absolute difference between consecutive frames, 0..1. `diffs[i]` compares frame i with i-1; `diffs[0]` is 0. */
export function frameDiffs(frames) {
  return frames.map((frame, i) => {
    if (i === 0) return 0;
    const prev = frames[i - 1];
    let sum = 0;
    for (let p = 0; p < frame.length; p++) sum += Math.abs(frame[p] - prev[p]);
    return sum / frame.length / 255;
  });
}

// Costs closer than this are ties (prefix-sum rounding noise must not decide between equal candidates).
const EPSILON = 1e-12;

/**
 * Choose [start, end) frame indexes. Cost = mean diff over the tailSec window at each end. `start` leaves
 * tailSec of earlier frames for the head-side crossfade source. Ties go to the earliest start, then the longest loop.
 */
export function pickLoopPoints(diffs, fps, { minSec = 8, maxSec = 15, tailSec = 0.5 } = {}) {
  const w = Math.round(tailSec * fps);
  const minLen = Math.round(minSec * fps);
  const maxLen = Math.round(maxSec * fps);
  const n = diffs.length;
  if (n < minLen + w) {
    throw new NoLoopError(`footage is ${(n / fps).toFixed(2)} s; a hero loop needs at least ${minSec + tailSec} s of footage`);
  }

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + diffs[i];
  const windowMean = (from) => (prefix[from + w] - prefix[from]) / w;

  let best = null;
  for (let start = w; start + minLen <= n; start++) {
    const head = windowMean(start);
    for (let len = Math.min(maxLen, n - start); len >= minLen; len--) {
      const end = start + len;
      const cost = head + windowMean(end - w);
      if (best === null || cost < best.score - EPSILON) best = { start, end, score: cost };
    }
  }
  return best;
}
