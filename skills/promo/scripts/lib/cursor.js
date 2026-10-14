export const MOVE_MS = 400;
export const PAUSE_MS = 150;
export const HOLD_MS = 600;

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Points from `from` to `to` (t in ms), eased with cubic ease-out; the last point is exactly `to`.
export function cursorPath(from, to, { durationMs = MOVE_MS, fps = 60 } = {}) {
  const steps = Math.max(1, Math.round((durationMs / 1000) * fps));
  const points = [];
  for (let i = 0; i < steps; i++) {
    const p = easeOutCubic(i / steps);
    points.push({
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p,
      t: (i / steps) * durationMs,
    });
  }
  points.push({ x: to.x, y: to.y, t: durationMs });
  return points;
}

// Per-character delay in ms: U(60,90) base plus U(-20,20) jitter, so 40..110 ms with mean 75.
export function typingDelays(text, rng) {
  return Array.from(text, () => 60 + rng() * 30 + (rng() * 40 - 20));
}

// Runs in the page (via addInitScript). The cursor and ripple are real DOM elements so the screencast captures them.
export const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__promoCursor) return;
  let x = -100, y = -100, shown = false;
  const SIZE = 28;
  function ensure() {
    const root = document.documentElement;
    if (!root) return null;
    if (!document.getElementById('__promo-cursor-style')) {
      const s = document.createElement('style');
      s.id = '__promo-cursor-style';
      s.textContent =
        '#__promo-cursor{position:fixed;left:0;top:0;width:' + SIZE + 'px;height:' + SIZE + 'px;margin:0;' +
        'pointer-events:none;z-index:2147483647;box-sizing:border-box;border-radius:50%;' +
        'background:rgba(255,255,255,.55);border:3px solid #111;box-shadow:0 2px 8px rgba(0,0,0,.45);opacity:0}' +
        '.ripple{position:fixed;width:' + SIZE + 'px;height:' + SIZE + 'px;margin:0;border-radius:50%;' +
        'pointer-events:none;z-index:2147483646;border:3px solid rgba(60,130,255,.9);' +
        'background:rgba(60,130,255,.25);animation:__promo-ripple 500ms ease-out forwards}' +
        '@keyframes __promo-ripple{from{transform:translate(var(--x),var(--y)) scale(.4);opacity:1}' +
        'to{transform:translate(var(--x),var(--y)) scale(2.4);opacity:0}}';
      root.appendChild(s);
    }
    let el = document.getElementById('__promo-cursor');
    if (!el) {
      el = document.createElement('div');
      el.id = '__promo-cursor';
      root.appendChild(el);
    }
    return el;
  }
  function place() {
    const el = ensure();
    if (!el) return;
    el.style.transform = 'translate(' + (x - SIZE / 2) + 'px,' + (y - SIZE / 2) + 'px)';
    el.style.opacity = shown ? '1' : '0';
  }
  window.__promoCursor = {
    moveTo(nx, ny) { x = nx; y = ny; shown = true; place(); },
    click(cx, cy) {
      this.moveTo(cx, cy);
      const root = document.documentElement;
      if (!root) return;
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.setProperty('--x', (cx - SIZE / 2) + 'px');
      r.style.setProperty('--y', (cy - SIZE / 2) + 'px');
      r.style.left = '0';
      r.style.top = '0';
      root.appendChild(r);
      setTimeout(() => r.remove(), 500);
    },
  };
  document.addEventListener('DOMContentLoaded', place);
  place();
})();`;
