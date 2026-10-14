// Hard gate 1: a recorded context may only ever navigate within staging.url's origin.
//
// Playwright's route is consulted for the first request of a navigation but NOT for the hops a browser
// follows after a 3xx (verified empirically, Playwright 1.64 / Chromium). So main-frame navigations are
// fetched here with redirects disabled, every hop's resolved origin is checked before it is requested, and
// only the final response is handed to the browser. A redirect to another origin is therefore never sent.
//
// Popups: a target=_blank link is opened noopener, and Chromium starts that request before Playwright can
// attach a route to the new page (verified: the request reaches the other server). So popups are handled
// in two layers. (1) POPUP_TO_SELF rewrites target/window.open to the current tab, which makes the
// navigation an ordinary, routed, main-frame one. (2) CHROMIUM_ARGS makes the browser refuse any new window
// that still gets through (silently: the request is never sent, but Playwright sees no page either).

export const CHROMIUM_ARGS = ['--block-new-web-contents'];

const POPUP_TO_SELF = `(() => {
  const toSelf = (el) => {
    const t = el && el.target;
    if (t && !['_self', '_parent', '_top'].includes(t) && !window.frames[t]) el.target = '_self';
  };
  document.addEventListener('click', (e) => toSelf(e.target.closest && e.target.closest('a[target], area[target]')), true);
  document.addEventListener('submit', (e) => toSelf(e.target), true);
  window.open = (url) => { if (url) location.href = String(url); return null; };
})();`;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 10;
const isHttp = (u) => u.protocol === 'http:' || u.protocol === 'https:';

// Resolved comparison, never a string prefix: 'http://app.test.evil.example' starts with 'http://app.test'.
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
};

/**
 * Installs the gate on a browser context. `gate.violation` is set to {origin, url} the first time a
 * navigation leaves `origin`; the caller checks it after every step and fails the flow.
 */
export async function installOriginGate(context, { origin, gate, mainPage }) {
  await context.addInitScript(POPUP_TO_SELF);
  const violate = (url, page) => {
    gate.violation ??= { origin: originOf(url), url };
    // A blocked popup must not linger (or be recorded); the flow's own page is never closed here.
    if (page && page !== mainPage()) page.close().catch(() => {});
  };

  await context.route('**/*', async (route) => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.continue();
    let frame;
    try { frame = req.frame(); } catch { return route.continue(); }
    // Embedded frames (an iframe widget) are content on the page, not a navigation away from it.
    if (frame.parentFrame()) return route.continue();
    const page = frame.page();

    let url = req.url();
    let method = req.method();
    let postData = req.postDataBuffer() ?? undefined;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (originOf(url) !== origin) {
        violate(url, page);
        return route.abort('blockedbyclient');
      }
      let resp;
      try {
        resp = await route.fetch({ url, method, postData, maxRedirects: 0 });
      } catch {
        return route.abort('failed');
      }
      const location = resp.headers().location;
      if (!REDIRECT_STATUS.has(resp.status()) || !location) return route.fulfill({ response: resp });
      let next;
      try {
        next = new URL(location, url).href;
      } catch {
        violate(location, page);
        return route.abort('blockedbyclient');
      }
      // 301/302/303 turn a non-GET into a GET without a body; 307/308 replay it.
      if (resp.status() === 303 || ((resp.status() === 301 || resp.status() === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        postData = undefined;
      }
      url = next;
    }
    return route.abort('failed'); // redirect loop
  });

  // Backstop: even if a navigation slipped past route, a main frame that lands elsewhere fails the flow.
  const watch = (page) => page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    let u;
    try { u = new URL(frame.url()); } catch { return; }
    if (isHttp(u) && u.origin !== origin) violate(u.href, page);
  });
  context.on('page', (page) => {
    // Not expected while CHROMIUM_ARGS is in force; if a window ever does appear, fail the flow rather than record around it.
    if (mainPage() && page !== mainPage()) gate.violation ??= { origin: 'a new window (popups are not recorded)', url: 'about:blank' };
    watch(page);
  });
  for (const p of context.pages()) watch(p);
}
