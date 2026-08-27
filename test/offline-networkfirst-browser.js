/*
 * Layer 4 proof #2 — NETWORK-FIRST HTML (no stale-app trap).
 * ---------------------------------------------------------------------------
 * The service worker is NETWORK-FIRST for the app shell, on purpose: when there
 * IS signal the builder always gets the freshest app, and the cache is only the
 * OFFLINE fallback. This proves BOTH directions with the real sw.js:
 *   ONLINE  — deploy a change; the next load picks it up (NOT served stale).
 *   OFFLINE — with no signal, the last-cached version is served (app still opens).
 *
 * The "deploy" is a build marker the server injects into the shell (V1 -> V2 ...);
 * changing it is exactly what a Netlify redeploy does to the served HTML.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  let VERSION = 'V1';     // the "deployed" build; the test mutates this to redeploy
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.indexOf('/.netlify/functions/config') === 0){ res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ secret:'' })); }
    if (u === '/.netlify/functions/supabase'){ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.setHeader('Content-Type','application/json'); res.end('[]'); }); return; }
    let rel = (u === '/' || u === '') ? 'ashland-stage-update-dev.html' : u.replace(/^\//,'');
    const f = path.join(ROOT, rel);
    if (f.indexOf(ROOT) === 0 && fs.existsSync(f) && fs.statSync(f).isFile()){
      const ext = path.extname(f);
      res.setHeader('Cache-Control','no-cache');
      if (ext === '.html'){
        let html = fs.readFileSync(f, 'utf8');
        // inject the current build marker — this is what "changes" on redeploy
        html = html.replace('</head>', '<script>window.__BUILD__="' + VERSION + '";</script></head>');
        res.setHeader('Content-Type','text/html'); return res.end(html);
      }
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':(ext==='.json'?'application/json':(ext==='.png'?'image/png':'text/plain')));
      return res.end(fs.readFileSync(f));
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const APP = 'http://127.0.0.1:' + server.address().port + '/ashland-stage-update-dev.html';

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const build = () => page.evaluate(() => window.__BUILD__);

  // ── warm: register SW, then a controlled reload caches V1 ──
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const warm = await build();                             // V1, now cached by the SW

  // ── ONLINE gets FRESH: "redeploy" V2, reload online -> must be V2, not stale V1 ──
  // This is the anti-stale guarantee: network-first means a new deploy is picked up
  // on the very next load, even though V1 is sitting in the SW cache.
  VERSION = 'V2';
  await page.reload({ waitUntil: 'load' });
  const onlineFresh = await build();                       // expect V2 (fresh), NOT V1 (cache)

  // ── OFFLINE serves CACHE: TRUE network failure, cold-start -> last-cached V2 ──
  // setOffline only flips navigator.onLine here (it does NOT sever localhost), so
  // we SHUT THE SERVER DOWN for a real failure. The SW's fetch now fails and it
  // falls back to the cache (V2, the last good load). The app must still open.
  await context.setOffline(true);
  await new Promise(r => server.close(r)); server.closeAllConnections && server.closeAllConnections();
  const p2 = await context.newPage(); p2.on('pageerror', e => errors.push('offline: ' + e));
  let offlineNavOk = true;
  try { await p2.goto(APP, { waitUntil: 'load' }); } catch(e){ offlineNavOk = false; }
  const offlineCached = await p2.evaluate(() => window.__BUILD__);   // expect V2 from cache

  console.log('\n===== Layer 4 proof #2 — NETWORK-FIRST HTML (real sw.js) =====\n');
  console.log('  warm (cached)   : ' + warm);
  console.log('  online after V2 : ' + onlineFresh + '   (fresh from network, not stale V1)');
  console.log('  offline cold    : ' + offlineCached + '   nav ok=' + offlineNavOk + '   (served from cache, server DOWN)');
  console.log('');

  check('warm load cached V1', warm === 'V1');
  check('ONLINE picks up the redeploy (V2 fresh, NOT stale V1 from cache)', onlineFresh === 'V2');
  check('OFFLINE still opens the app with server DOWN (nav served from SW cache)', offlineNavOk === true);
  check('OFFLINE serves the LAST-CACHED build (V2)', offlineCached === 'V2');
  check('no page errors ('+errors.length+')', errors.length === 0);

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  try { server.close(); } catch(e){}   // already closed for the true-offline phase
  process.exit(allPass ? 0 : 1);
})();
