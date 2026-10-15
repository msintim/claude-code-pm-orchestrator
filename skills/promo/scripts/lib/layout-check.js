import { safeBand } from './geometry.js';

const TOL = 1; // px of sub-pixel slack

/**
 * Every visible [data-field] must sit inside #stage, not spill out of its own box, and for 9:16
 * stay inside the platform safe band. Run it with the scene's frame already driven.
 */
export async function checkLayout(page, { size, sceneIndex }) {
  const band = safeBand(size);
  const found = await page.evaluate(({ band: b, tol }) => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll('[data-field]')) {
      if (!el.getClientRects().length) continue; // not displayed
      const field = el.dataset.field;
      const r = el.getBoundingClientRect();
      const rel = { left: r.left - stage.left, top: r.top - stage.top, right: r.right - stage.left, bottom: r.bottom - stage.top };
      const fmt = (v) => Math.round(v * 10) / 10;
      // Inline text can poke past a tight line-height by its font's ascent/descent, so vertical slack is 0.3em.
      const slackY = tol + 0.3 * parseFloat(getComputedStyle(el).fontSize);
      if (el.scrollWidth > el.clientWidth + tol || el.scrollHeight > el.clientHeight + slackY) {
        out.push({ kind: 'overflow', field, detail: `content ${el.scrollWidth}x${el.scrollHeight} exceeds its ${el.clientWidth}x${el.clientHeight} box` });
      }
      // An auto-height field never overflows its own box, so also require it to stay inside the content
      // box of its template (the section minus its padding, which carries the safe band): text that
      // wraps into more lines than fit spills into that padding.
      const host = el.closest('[data-template]');
      if (host) {
        const h = host.getBoundingClientRect();
        const cs = getComputedStyle(host);
        const inset = (side) => parseFloat(cs[`padding${side}`]) + parseFloat(cs[`border${side}Width`]);
        const box = { left: h.left + inset('Left'), top: h.top + inset('Top'), right: h.right - inset('Right'), bottom: h.bottom - inset('Bottom') };
        if (r.left < box.left - tol || r.top < box.top - tol || r.right > box.right + tol || r.bottom > box.bottom + tol) {
          out.push({
            kind: 'overflow',
            field,
            detail: `box ${fmt(r.left - box.left)},${fmt(r.top - box.top)} to ${fmt(r.right - box.left)},${fmt(r.bottom - box.top)} leaves the ${fmt(box.right - box.left)}x${fmt(box.bottom - box.top)} content area of its template`,
          });
        }
      }
      if (rel.left < -tol || rel.top < -tol || rel.right > stage.width + tol || rel.bottom > stage.height + tol) {
        out.push({ kind: 'outside-stage', field, detail: `box ${fmt(rel.left)},${fmt(rel.top)} to ${fmt(rel.right)},${fmt(rel.bottom)} is outside ${fmt(stage.width)}x${fmt(stage.height)}` });
      }
      if (b.top > 0 || b.bottom > 0) {
        if (rel.top < b.top - tol || rel.bottom > stage.height - b.bottom + tol) {
          out.push({ kind: 'safe-area', field, detail: `box ${fmt(rel.top)} to ${fmt(rel.bottom)} leaves the safe band ${fmt(b.top)} to ${fmt(stage.height - b.bottom)}` });
        }
      }
    }
    return out;
  }, { band, tol: TOL });
  return found.map((issue) => ({ ...issue, scene: sceneIndex }));
}
