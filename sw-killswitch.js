// KILL-SWITCH service worker — RECOVERY ONLY, not deployed in normal operation.
// ---------------------------------------------------------------------------
// If the offline service worker (ashland-field-ops-v4) ever misbehaves on live, deploy
// THIS file's contents AS `sw.js` (copy over sw.js, commit, push to main). Because the
// browser byte-compares sw.js on every navigation, each builder picks this up on their
// next load; on activate it (1) deletes every cache and (2) unregisters itself, then
// (3) reloads open clients — reverting the origin to plain network with NO service
// worker. It self-destructs: once unregistered, nothing intercepts requests.
//
// This is the insurance net: a bad SW can't be removed by deleting the file (a
// registered SW keeps running), but it CAN be removed by shipping a self-unregistering
// one. Network-first already means an online builder always gets fresh HTML, so this is
// a belt-and-suspenders full removal, not the only recovery (fix-forward also works).
//
// Recovery steps (kept short so it's copy-paste under pressure):
//   cp sw-killswitch.js sw.js && git commit -am "KILL-SWITCH: neuter offline SW" && git push origin main

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });   // reload → drops SW control
    } catch (e) {}
  })());
});

// No fetch handler on purpose: this SW never intercepts. Requests go straight to the
// network while it briefly lives, and after unregister it is gone entirely.
