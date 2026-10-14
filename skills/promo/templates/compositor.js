// Frame compositor. A frame is a pure function of t: every animation is paused and seeked with
// Animation.currentTime, so no wall clock, requestAnimationFrame timing or running transition is involved.
import { buildTimeline, at } from '../lib/timeline.js';
import { safeBand } from '../lib/geometry.js';

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'system-ui']);
const stage = document.getElementById('stage');
const dip = document.getElementById('dip');
const templateCache = new Map();

let timeline = null;
let layers = [];

const ease = (p) => (1 - Math.cos(Math.PI * Math.min(Math.max(p, 0), 1))) / 2;

function fontStack(font) {
  if (GENERIC_FONTS.has(font)) return font;
  return `"${font.replace(/["\\\r\n]/g, '')}", sans-serif`;
}

async function loadTemplate(name) {
  if (!templateCache.has(name)) {
    templateCache.set(name, (async () => {
      const res = await fetch(`${name}.html`);
      if (!res.ok) throw new Error(`template ${name}.html: HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      return doc.body.firstElementChild;
    })());
  }
  return (await templateCache.get(name)).cloneNode(true);
}

// Field text goes in through textContent only; a field the scene does not set is removed.
function fillFields(section, scene) {
  for (const el of [...section.querySelectorAll('[data-field]')]) {
    const value = scene[el.dataset.field];
    if (typeof value === 'string') el.textContent = value;
    else el.remove();
  }
}

async function buildLayer(scene) {
  const el = document.createElement('div');
  el.className = 'layer';
  // Footage scenes are composited in Task 9; until then they are a blank layer of the stage background.
  if (scene.type !== 'footage') {
    const section = await loadTemplate(scene.type);
    fillFields(section, scene);
    el.append(section);
  }
  stage.insertBefore(el, dip);
  return el;
}

async function init({ scenes, brand, size, fps = 30 }) {
  stage.style.width = `${size.w}px`;
  stage.style.height = `${size.h}px`;
  stage.dataset.theme = brand.theme;
  stage.style.setProperty('--brand-primary', brand.primary);
  stage.style.setProperty('--brand-accent', brand.accent);
  stage.style.setProperty('--brand-font', fontStack(brand.font));
  const band = safeBand(size);
  stage.style.setProperty('--safe-top', `${band.top}px`);
  stage.style.setProperty('--safe-bottom', `${band.bottom}px`);

  layers.forEach((l) => l.remove());
  timeline = buildTimeline(scenes, fps);
  layers = await Promise.all(scenes.map(buildLayer));
  await settle();
}

async function settle() {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
}

function show(index, localT, { z = 1, x = 0 } = {}) {
  const layer = layers[index];
  layer.style.display = 'block';
  layer.style.zIndex = String(z);
  layer.style.transform = x === 0 ? '' : `translateX(${x}%)`;
  // The sliding panel's leading edge needs a visible shadow: a panel that is still entering is otherwise blank.
  layer.style.boxShadow = x === 0 ? '' : '-2cqmin 0 5cqmin rgba(0, 0, 0, 0.25)';
  // Animations exist only once the layer is displayed (display:none cancels them), so seek after showing.
  for (const a of document.getAnimations()) {
    if (a.effect?.target && layer.contains(a.effect.target)) {
      a.pause();
      a.currentTime = localT * 1000;
    }
  }
}

async function renderFrame(t) {
  if (!timeline) throw new Error('compositor not initialised');
  for (const l of layers) {
    l.style.display = 'none';
    l.style.transform = '';
    l.style.boxShadow = '';
  }
  dip.style.opacity = '0';

  const f = at(timeline, t);
  const tr = f.transition;
  if (!tr) {
    show(f.outgoing.index, f.outgoing.localT);
  } else if (tr.kind === 'dip-to-brand') {
    const first = tr.progress < 0.5;
    const side = first ? f.outgoing : f.incoming;
    show(side.index, side.localT);
    dip.style.opacity = String(ease(1 - Math.abs(2 * tr.progress - 1)));
  } else {
    show(f.outgoing.index, f.outgoing.localT, { z: 1 });
    show(f.incoming.index, f.incoming.localT, { z: 2, x: (1 - ease(tr.progress)) * 100 });
  }
  await settle();
}

window.__promo = { init, renderFrame };

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (event.origin !== location.origin || msg?.type !== 'render') return;
  await renderFrame(msg.t);
  window.postMessage({ type: 'frame-ready', t: msg.t }, location.origin);
});
