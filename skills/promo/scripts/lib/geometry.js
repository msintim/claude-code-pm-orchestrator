// Pure crop/safe-area arithmetic. Isomorphic: no node: imports, so the
// browser compositor can import it unchanged.

const SAFE_TOP = 250;
const SAFE_BOTTOM = 340;
const SAFE_REF_HEIGHT = 1920;
const BOTTOM_MARGIN_FRAC = 0.08;

/** Grow the short axis about the rect centre until w/h === ratio. */
export function padToRatio(rect, ratio) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let { w, h } = rect;
  if (w / h < ratio) w = h * ratio;
  else h = w / ratio;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Shift inside the frame; if larger than the frame, scale down about the centre. */
export function clampToFrame(rect, frame) {
  let { w, h } = rect;
  let x = rect.x;
  let y = rect.y;
  const scale = Math.min(1, frame.w / w, frame.h / h);
  if (scale < 1) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    w *= scale;
    h *= scale;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  x = Math.min(Math.max(x, 0), frame.w - w);
  y = Math.min(Math.max(y, 0), frame.h - h);
  return { x, y, w, h };
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);

function intersectionArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return area({ w, h });
}

/**
 * Choose the source rectangle to show for a target aspect ratio.
 * Order: min-width rule, pad to ratio, clamp to the source frame.
 */
export function cropForRatio(focus, source, target, opts = {}) {
  const sourceScale = opts.sourceScale ?? 2;
  const ratio = target.w / target.h;

  if (!focus) {
    // Largest ratio-shaped rect that fits, centred.
    const scale = Math.min(source.w / (source.h * ratio), 1);
    const w = source.h * ratio * scale;
    const h = w / ratio;
    return {
      rect: { x: (source.w - w) / 2, y: (source.h - h) / 2, w, h },
      coverage: 1,
      centered: true,
    };
  }

  const minW = target.w / sourceScale;
  let r = focus;
  if (r.w < minW) r = { x: r.x + r.w / 2 - minW / 2, y: r.y, w: minW, h: r.h };
  r = clampToFrame(padToRatio(r, ratio), source);

  const fa = area(focus);
  const coverage = fa > 0 ? intersectionArea(focus, r) / fa : 1;
  return { rect: r, coverage, centered: false };
}

/** Platform overlay zones; only 9:16 has them. Scaled from a 1080x1920 reference. */
export function safeBand(size) {
  if (size.w * 16 !== size.h * 9) return { top: 0, bottom: 0 };
  const k = size.h / SAFE_REF_HEIGHT;
  return { top: SAFE_TOP * k, bottom: SAFE_BOTTOM * k };
}

/** Bottom-anchored caption bar inside the safe band. */
export function captionRect(size, opts = {}) {
  const heightFrac = opts.heightFrac ?? 0.1;
  const band = safeBand(size);
  const margin = band.bottom > 0 ? band.bottom : size.h * BOTTOM_MARGIN_FRAC;
  const h = size.h * heightFrac;
  const x = size.w * 0.06;
  return { x, y: size.h - margin - h, w: size.w - 2 * x, h };
}
