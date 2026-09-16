// Ashland Homes Field Operations — Service Worker
// Offline app LAUNCH (Layer 4). Strategy: NETWORK-FIRST for every same-origin GET
// (HTML + JS modules + manifest/icons) — always prefer the freshest version when
// online, cache only as the OFFLINE fallback. This is what keeps builders from
// getting trapped on a stale cached app: with signal, they always get the latest.
// Writes (POST to the backend) are never intercepted — they go straight to the
// network, and the app's own durable queue handles them when offline. Cross-origin
// (Google Fonts) is left to the browser: offline it falls back to system fonts.
//
// OFFLINE CONTRACT: respondWith must ALWAYS resolve to a real Response — never null.
// The previous handler did `.catch(() => caches.match(req))`, and caches.match
// resolves to `undefined` on a miss, which WebKit surfaces as
// "FetchEvent.respondWith received an error: Returned response is null" and the page
// fails to open offline. The handler below can never return null: it tries the cache
// (ignoring the ?v= query), then for a navigation falls back to the cached app SHELL,
// then to a built-in offline page. The shell + JS modules are also PRECACHED at
// install so a cold offline launch has them even before the network-first path has
// run once.

const CACHE_NAME = 'ashland-field-ops-v5';

// Precache the app shell, its JS modules, and icons so an OFFLINE cold-start has a
// guaranteed shell to serve — not dependent on the network-first path having cached
// the page on a prior load. sw.js is shared dev+live, so we list BOTH the dev and
// live filenames; the one that doesn't exist on this site 404s and allSettled ignores
// it. Query-less keys; the fetch handler matches with ignoreSearch so `foo.js?v=2`
// still hits the precached `foo.js`.
const PRECACHE = [
  '/ashland-stage-update.html', '/ashland-stage-update-dev.html',
  '/schedule-engine.js', '/note-resolution.js', '/offline-queue.js', '/offline-data.js',
  '/manifest.json', '/manifest-dev.json',
  '/icon-192.png', '/icon-512.png', '/icon-dev-192.png', '/icon-dev-512.png',
  '/apple-touch-icon.png', '/apple-touch-icon-dev.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))   // ignore any 404s (cross-branch filenames)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Return the best cached app-shell HTML for an offline navigation. Prefer the exact
// path that was requested (dev vs live), then either known shell. Query is ignored.
async function cachedShell(cache, url) {
  return (await cache.match(url.pathname, { ignoreSearch: true }))
      || (await cache.match('/ashland-stage-update-dev.html', { ignoreSearch: true }))
      || (await cache.match('/ashland-stage-update.html', { ignoreSearch: true }))
      || null;
}

const OFFLINE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Offline</title></head>' +
  '<body style="font-family:-apple-system,system-ui,sans-serif;margin:0;padding:2.5rem 1.5rem;' +
  'text-align:center;color:#1a1a1a;background:#f3f4f6">' +
  '<h1 style="color:#00A9D1;font-size:1.25rem">You’re offline</h1>' +
  '<p style="color:#6b7280">This app hasn’t finished saving itself for offline use yet. ' +
  'Reconnect once, let it load fully, then it will open offline.</p>' +
  '</body></html>';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // writes go straight to network
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;        // cross-origin (fonts) -> browser default

  const isNavigation = req.mode === 'navigate' || req.destination === 'document';

  // NETWORK-FIRST, with an offline fallback that ALWAYS yields a real Response.
  event.respondWith((async () => {
    try {
      const resp = await fetch(req);
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
      }
      return resp;                                        // online: fresh (even a 404 is a real Response)
    } catch (e) {
      // OFFLINE (fetch rejected). Serve from cache — and never return null/undefined.
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (isNavigation) {
        const shell = await cachedShell(cache, url);
        if (shell) return shell;                          // the whole point: offline page load
        return new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      // Non-navigation miss (a JS/image not cached): a real 503, not null.
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
