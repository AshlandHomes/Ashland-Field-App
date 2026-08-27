/*
 * Layer 4 proof #1 — OFFLINE COLD-START (the core proof).
 * ---------------------------------------------------------------------------
 * A builder loads the app ONLINE (service worker installs, caches the app shell;
 * the data reads cache in OfflineData; the login persists a session). Then the
 * phone loses all signal and the app is CLOSED. On a fresh, no-network launch the
 * app must OPEN (shell served from the SW cache), let the builder back in (PIN
 * verified locally), and RENDER their lots (served from the OfflineData cache).
 *
 * Everything below drives the REAL field app + REAL sw.js + REAL offline-data.js
 * over a real HTTP origin (127.0.0.1 = a secure context, so SWs run). Offline is
 * the browser's true offline (context.setOffline) — not a stub.
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

// ── a realistic backend for the field app's POST actions ──
function backend(action, payload){
  switch(action){
    case 'getBuilders': return [{ name:'Marisa', is_admin:false }, { name:'Collin', is_admin:false }];
    case 'verifyPin': return { valid: payload && payload.pin === '1234' };
    case 'getScheduleLots': return [
      { id:'L1', lot_number:'12', community:'CO', builder_name:'Marisa', reported_stage:'2.0',
        construction_start_date:'2026-05-01', status:'active', template_id:null,
        manual_stage:null, completion_stamped_at:null, scheduled_close_date:null }
    ];
    case 'getScheduleLotTasks': return { tasks:[
        { id:'k1', bt_num:84, name:'Trim', relative_start:1, duration:2, lag:0, relative_finish:2,
          predecessors:[], phase_order:1, phase_name:'Interior', task_type:'work', task_order:1,
          status:'started', actual_start:'2026-08-20', actual_finish:null, note:'', flag:'none',
          est_start_date:null, is_critical:true, vendor_confirmed:false } ], gates:[] };
    case 'getTemplateStageMap': return { stages:[] };
    case 'getTaskNotes': return [];
    case 'getPendingResolutions': return [];
    default: return {};
  }
}

(async () => {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.indexOf('/.netlify/functions/config') === 0){ res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ secret:'' })); }
    if (u === '/.netlify/functions/supabase' && req.method === 'POST'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
        let d={}; try{ d=JSON.parse(body); }catch(e){}
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(backend(d.action, d.payload)));
      });
      return;
    }
    // static: the field app HTML (map '/' too), JS modules, manifest, icons
    let rel = (u === '/' || u === '') ? 'ashland-stage-update-dev.html' : u.replace(/^\//,'');
    const f = path.join(ROOT, rel);
    if (f.indexOf(ROOT) === 0 && fs.existsSync(f) && fs.statSync(f).isFile()){
      const ext = path.extname(f);
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':(ext==='.json'?'application/json':(ext==='.html'?'text/html':(ext==='.png'?'image/png':'text/plain'))));
      res.setHeader('Cache-Control','no-cache');
      return res.end(fs.readFileSync(f));
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const APP = origin + '/ashland-stage-update-dev.html';

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const errors = [];

  // ── PHASE A: ONLINE — register SW, cache the shell, log in, cache the data ──
  const p1 = await context.newPage();
  p1.on('pageerror', e => errors.push('online: ' + e));
  await p1.goto(APP, { waitUntil: 'load' });
  await p1.evaluate(() => navigator.serviceWorker.ready);         // SW installed + active
  await p1.reload({ waitUntil: 'load' });                          // now SW-controlled -> shell caches via network-first
  await p1.waitForFunction(() => !!navigator.serviceWorker.controller);

  const online = await p1.evaluate(async () => {
    // real login through the real code path (persists the session + caches reads)
    currentBuilder = 'Marisa'; pinEntry = '1234';
    await tryPin();                                                // online verify -> saveSession -> enterApp -> loadMyLots
    // give enterApp's loadMyLots().then(checkPendingResolutions) a beat
    await new Promise(r => setTimeout(r, 100));
    // also warm the per-lot caches the builder would see (open the lot once online)
    await openLot('L1');
    const cacheKeys = await caches.open('ashland-field-ops-v4').then(c => c.keys()).then(ks => ks.map(r => r.url));
    return {
      loggedIn: (document.querySelector('.screen.active')||{}).id,
      myLots: (typeof myLots!=='undefined' ? myLots.length : -1),
      session: !!(localStorage.getItem('afo_session_v1')),
      cachedLots: await OfflineData.get('getScheduleLots', {}),
      cachedTasks: await OfflineData.get('getScheduleLotTasks', { lot_id:'L1' }),
      shellCached: cacheKeys.some(k => /ashland-stage-update-dev\.html/.test(k)),
      engineCached: cacheKeys.some(k => /schedule-engine\.js/.test(k)),
      dataCached: cacheKeys.some(k => /offline-data\.js/.test(k)),
    };
  });

  // ── PHASE B: OFFLINE COLD-START — TRUE network failure, launch a BRAND NEW page ──
  // NOTE: context.setOffline only flips navigator.onLine in this sandbox; it does
  // NOT sever localhost traffic. So we genuinely SHUT THE SERVER DOWN — now every
  // real fetch (the SW's shell fetch AND the app's probe) fails for real, and the
  // only way the app can open is the SW cache + OfflineData. That's the true test.
  await context.setOffline(true);                                 // navigator.onLine=false (real device state)
  await new Promise(r => server.close(r)); server.closeAllConnections && server.closeAllConnections();
  const p2 = await context.newPage();
  p2.on('pageerror', e => errors.push('coldstart: ' + e));
  let navFailed = false;
  try { await p2.goto(APP, { waitUntil: 'load' }); }              // must be served from the SW cache
  catch(e){ navFailed = true; }

  const cold = await p2.evaluate(async () => {
    // startup IIFE probes (fails -> offline) and, seeing the saved session,
    // resumes to this builder's PIN screen. Wait for that to settle.
    await new Promise(r => setTimeout(r, 400));
    const before = (document.querySelector('.screen.active')||{}).id;
    const nameShown = (document.getElementById('pin-name')||{}).textContent;
    // builder taps their PIN — verified LOCALLY (no server)
    pinEntry = '1234';
    await tryPin();
    await new Promise(r => setTimeout(r, 150));
    const active = document.querySelector('.screen.active') || {};
    const after = active.id;
    // a single community auto-opens screen-lots (lots-list); many -> screen-subs (subs-list).
    // Read the ACTIVE screen's list only (subs-list keeps a stale "Loading" placeholder
    // when we jump straight past it).
    const listEl = (active.querySelector ? active.querySelector('#lots-list,#subs-list') : null);
    const listHtml = listEl ? listEl.innerHTML : '';
    const status = (document.getElementById('sync-status')||{}).textContent || '';
    return { online:_isOnline, before, nameShown, after,
             myLots:(typeof myLots!=='undefined'?myLots.length:-1),
             lotShown:/12/.test(listHtml) && !/Loading/.test(listHtml),
             status };
  });

  console.log('\n===== Layer 4 proof #1 — OFFLINE COLD-START (real SW + real data cache) =====\n');
  console.log('  ONLINE warm-up: ' + JSON.stringify(online));
  console.log('  OFFLINE cold  : ' + JSON.stringify(cold));
  console.log('');

  // online warm-up sanity
  check('ONLINE: logged in and lot loaded (myLots=1)', online.myLots === 1 && online.loggedIn === 'screen-schedule');
  check('ONLINE: session persisted for offline re-launch', online.session === true);
  check('ONLINE: data cached (getScheduleLots + getScheduleLotTasks)', !!online.cachedLots && !!online.cachedTasks && online.cachedLots[0].lot_number === '12');
  check('ONLINE: SW cached the app shell (HTML + JS modules)', online.shellCached && online.engineCached && online.dataCached);
  // the actual proof
  check('OFFLINE: fresh page OPENED from cache (navigation did not fail)', navFailed === false);
  check('OFFLINE: startup detected no signal (_isOnline=false)', cold.online === false);
  check('OFFLINE: resumed to the saved builder\'s PIN screen', cold.before === 'screen-pin' && /Marisa/.test(cold.nameShown||''));
  check('OFFLINE: local PIN unlocked the app (no server)', cold.after === 'screen-subs' || cold.after === 'screen-lots');
  check('OFFLINE: cached lots RENDERED (lot 12 visible, myLots=1)', cold.myLots === 1 && cold.lotShown);
  check('OFFLINE: status pill shows offline + staleness', /offline/.test(cold.status) && /synced/.test(cold.status));
  check('no page errors ('+errors.length+')', errors.length === 0);

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  try { server.close(); } catch(e){}   // already closed in Phase B (true-offline sim)
  process.exit(allPass ? 0 : 1);
})();
