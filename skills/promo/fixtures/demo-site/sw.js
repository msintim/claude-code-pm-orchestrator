// Fixture service worker: answers a navigation to /sw-target by fetching ?to= (another origin) from inside the worker.
const to = new URL(self.location.href).searchParams.get('to');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate' && new URL(e.request.url).pathname === '/sw-target') {
    e.respondWith(fetch(to, { mode: 'no-cors' })); // the request itself is the leak
  }
});
