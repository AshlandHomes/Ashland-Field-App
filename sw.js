// Ashland Homes Field Operations — Service Worker
// Offline app LAUNCH (Layer 4). Strategy: NETWORK-FIRST for every same-origin GET
// (HTML + JS modules + manifest/icons) — always prefer the freshest version when
// online, cache only as the OFFLINE fallback. This is what keeps builders from
// getting trapped on a stale cached app: with signal, they always get the latest.
// Writes (POST to the backend) are never intercepted — they go straight to the
// network, and the app's own durable queue handles them when offline. Cross-origin
// (Google Fonts) is left to the browser: offline it falls back to system fonts.

const CACHE_NAME = 'ashland-field-ops-v4';
// Best-effort precache of the query-less, dev+live-identical assets. The HTML and
// the versioned JS modules are cached on first online load by the network-first
// handler below (so we don't hard-code a filename that differs dev vs live).
const PRECACHE = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))   // ignore any 404s
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // writes go straight to network
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;        // cross-origin (fonts) -> browser default

  // NETWORK-FIRST: fetch fresh, cache the good response, fall back to cache offline.
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return resp;
      })
      .catch(() => caches.match(req))
  );
});
