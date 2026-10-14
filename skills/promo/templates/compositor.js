// Frame compositor. A frame is a pure function of t: every animation is paused and seeked with
// Animation.currentTime, so no wall clock, requestAnimationFrame timing or running transition is involved.
import { buildTimeline, at } from '../lib/timeline.js';
import { safeBand, cropForRatio, captionRect } from '../lib/geometry.js';

// The capture viewport (1920x1080 CSS, recorded at 60 fps); every flow video is treated as this size.
const SOURCE = { w: 1920, h: 1080 };
const SOURCE_FPS = 60;
const SEEK_TIMEOUT_MS = 10000;

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'system-ui']);
const stage = document.getElementById('stage');
const dip = document.getElementById('dip');
const templateCache = new Map();

let timeline = null;
let layers = [];
let specScenes = [];
let stageSize = null;
let captionModeName = null; // 'feed' | 'reel' | null, stamped on the caption bar
const videos = new Map(); // layer index -> video element

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

function loadVideo(video, flow) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(`footage video for flow "${flow}" cannot be played: ${video.error?.message || 'decode error'}`));
    video.addEventListener('error', fail, { once: true });
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    if (video.readyState >= 2) resolve();
  });
}

// A footage layer is a video sized to the source, transformed so the crop rect fills the stage,
// with the caption bar on top at captionRect(size).
async function buildFootageLayer(el, scene, index) {
  const { rect } = cropForRatio(scene.focus, SOURCE, stageSize);
  const k = stageSize.w / rect.w;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = `/capture/${scene.flow}.webm`;
  video.style.cssText = `position:absolute;left:0;top:0;width:${SOURCE.w}px;height:${SOURCE.h}px;`
    + `transform-origin:0 0;transform:scale(${k}) translate(${-rect.x}px,${-rect.y}px);`;
  el.append(video);
  await loadVideo(video, scene.flow);
  videos.set(index, video);
  if (typeof scene.caption === 'string') {
    const bar = await loadTemplate('caption-bar');
    fillFields(bar, scene);
    if (captionModeName) bar.dataset.captionMode = captionModeName;
    const c = captionRect(stageSize);
    // Pin the bar to captionRect, whatever the ratio; the stylesheet's inset only approximates it.
    bar.style.cssText = `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;right:auto;bottom:auto;`
      + 'justify-content:center;z-index:3;';
    el.append(bar);
  }
}

async function buildLayer(scene, index) {
  const el = document.createElement('div');
  el.className = 'layer';
  stage.insertBefore(el, dip);
  if (scene.type === 'footage') {
    await buildFootageLayer(el, scene, index);
  } else {
    const section = await loadTemplate(scene.type);
    fillFields(section, scene);
    el.append(section);
  }
  return el;
}

const withTimeout = (promise, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), SEEK_TIMEOUT_MS)),
]);

// Centre of the source frame that scene-local time lt falls in, so the seek never lands on a frame boundary.
function sourceTime(scene, lt) {
  return (Math.floor((scene.in + lt) * SOURCE_FPS + 1e-6) + 0.5) / SOURCE_FPS;
}

// requestVideoFrameCallback would be the exact signal, but in the headless render page it never fires
// (it timed out every time), so after the seek settles we let two animation frames present the frame.
function nextFrames(count) {
  return new Promise((resolve) => {
    const step = (n) => (n === 0 ? resolve() : requestAnimationFrame(() => step(n - 1)));
    step(count);
  });
}

async function seekFootage(index, lt) {
  const video = videos.get(index);
  const time = sourceTime(specScenes[index], lt);
  const seeked = new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
  video.currentTime = time;
  await withTimeout(seeked, `seek to ${time}s of flow "${specScenes[index].flow}"`);
  await nextFrames(2);
}

async function init({ scenes, brand, size, fps = 30, captionMode = null }) {
  captionModeName = captionMode;
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
  videos.clear();
  specScenes = scenes;
  stageSize = size;
  timeline = buildTimeline(scenes, fps);
  layers = await Promise.all(scenes.map(buildLayer));
  await settle();
}

async function settle() {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
}

async function show(index, localT, { z = 1, x = 0 } = {}) {
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
  if (videos.has(index)) await seekFootage(index, localT);
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
    await show(f.outgoing.index, f.outgoing.localT);
  } else if (tr.kind === 'dip-to-brand') {
    const first = tr.progress < 0.5;
    const side = first ? f.outgoing : f.incoming;
    await show(side.index, side.localT);
    dip.style.opacity = String(ease(1 - Math.abs(2 * tr.progress - 1)));
  } else {
    await show(f.outgoing.index, f.outgoing.localT, { z: 1 });
    await show(f.incoming.index, f.incoming.localT, { z: 2, x: (1 - ease(tr.progress)) * 100 });
  }
  await settle();
}

window.__promo = { init, renderFrame };

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (event.origin !== location.origin || msg?.type !== 'render') return;
  try {
    await renderFrame(msg.t);
    window.postMessage({ type: 'frame-ready', t: msg.t }, location.origin);
  } catch (e) {
    window.postMessage({ type: 'frame-error', t: msg.t, message: String(e?.message ?? e) }, location.origin);
  }
});
