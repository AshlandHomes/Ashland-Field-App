/*
 * Layer 4b proof — BACKGROUND TERRITORY PREFETCH at builder scale.
 * ---------------------------------------------------------------------------
 * A builder owns 50+ active lots and can't pre-open each one. On online load the
 * app must be usable in seconds, then cache the WHOLE territory in the background
 * so ALL lots (not just opened ones) work offline. This proves:
 *   - the fill runs in the background (login returns immediately; lots trickle in)
 *   - progress pill: "⏳ Caching N/50 offline" -> "✓ 50 lots ready offline"
 *   - order is RECENTLY-ACTIVE-FIRST (highest updated_at cached first)
 *   - after the fill, every one of the 50 lots' tasks+notes is in the cache
 *   - server SHUT DOWN, a lot NEVER manually opened still opens offline from cache
 *
 * Real field app + real offline-data.js over a real origin; true offline = server down.
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

const N = 50;
// 50 active lots for Marisa across 2 communities; lot number K has updated_at K
// minutes ago-from-base so HIGHER K = MORE recent -> cached first.
const LOTS = [];
for (let k = 1; k <= N; k++){
  LOTS.push({ id:'L'+k, lot_number:String(k), community:(k%2?'CO':'CT'), builder_name:'Marisa',
    reported_stage:'2.0', status:'active', template_id:'T1', manual_stage:null,
    completion_stamped_at:null, scheduled_close_date:null,
    updated_at:new Date(Date.UTC(2026,7,1,0,k,0)).toISOString() });   // k min -> higher k = later
}
// a couple of closed lots that must be SKIPPED
LOTS.push({ id:'Lclosed', lot_number:'999', community:'CO', builder_name:'Marisa', reported_stage:'6.0', status:'closed', template_id:'T1', updated_at:new Date().toISOString() });

const tasksFor = id => ({ tasks:[{ id:id+'-k1', bt_num:84, name:'Trim', relative_start:1, duration:2, lag:0,
  relative_finish:2, predecessors:[], phase_order:1, phase_name:'Interior', task_type:'work', task_order:1,
  status:'started', actual_start:'2026-08-20', actual_finish:null, note:'', flag:'none', est_start_date:null,
  is_critical:true, vendor_confirmed:false }], gates:[] });

(async () => {
  const taskReqOrder = [];   // order the server received getScheduleLotTasks (proves priority)
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.indexOf('/.netlify/functions/config') === 0){ res.setHeader('Content-Type','application/json'); return res.end('{"secret":""}'); }
    if (u === '/.netlify/functions/supabase' && req.method === 'POST'){
      let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
        let d={}; try{ d=JSON.parse(b); }catch(e){}
        res.setHeader('Content-Type','application/json');
        const p = d.payload || {};
        switch(d.action){
          case 'getBuilders': return res.end(JSON.stringify([{name:'Marisa',is_admin:false}]));
          case 'verifyPin': return res.end(JSON.stringify({valid: p.pin==='1234'}));
          case 'getScheduleLots': return res.end(JSON.stringify(LOTS));
          case 'getScheduleLotTasks': taskReqOrder.push(p.lot_id); return res.end(JSON.stringify(tasksFor(p.lot_id)));
          case 'getTemplateStageMap': return res.end(JSON.stringify({stages:[]}));
          case 'getTaskNotes': return res.end(JSON.stringify([{id:p.lot_id+'-n1', bt_num:84, note:'cached note', flag:'none', author:'Marisa', created_at:'2026-08-20T00:00:00Z'}]));
          case 'getPendingResolutions': return res.end('[]');
          default: return res.end('{}');
        }
      });
      return;
    }
    let rel = (u==='/'||u==='') ? 'ashland-stage-update-dev.html' : u.replace(/^\//,'');
    const f = path.join(ROOT, rel);
    if (f.indexOf(ROOT)===0 && fs.existsSync(f) && fs.statSync(f).isFile()){
      const ext = path.extname(f);
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':(ext==='.json'?'application/json':(ext==='.html'?'text/html':'text/plain')));
      return res.end(fs.readFileSync(f));
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const APP = 'http://127.0.0.1:' + server.address().port + '/ashland-stage-update-dev.html';

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const p1 = await context.newPage();
  const errors = []; p1.on('pageerror', e => errors.push('online: ' + e));
  await p1.goto(APP, { waitUntil: 'load' });
  await p1.evaluate(() => navigator.serviceWorker.ready);
  await p1.reload({ waitUntil: 'load' });

  // log in; fill runs in the BACKGROUND (we do NOT await it)
  const immediate = await p1.evaluate(async () => {
    PREFETCH_THROTTLE_MS = 3;                       // speed the throttle for the test (behavior identical)
    await OfflineData._clearAll();
    currentBuilder='Marisa'; pinEntry='1234';
    const t0 = performance.now();
    await tryPin();                                 // enterApp -> loadMyLots -> kicks prefetch (not awaited)
    const loginMs = performance.now() - t0;
    return { loginMs, listCount: (typeof myLots!=='undefined'?myLots.length:-1),
             cacheStateRightAfterLogin: _cacheStatus.state };
  });

  // the list loads right after (app usable); the fill had NOT completed when login
  // returned (proves it doesn't block on the fill).
  // list includes the closed lot too (loadMyLots filters by stage, not status) -> 51;
  // the prefetch correctly caches only the 50 ACTIVE ones (asserted below).
  await p1.waitForFunction(() => typeof myLots !== 'undefined' && myLots.length >= 50, { timeout: 8000 });
  const listCount = await p1.evaluate(() => myLots.length);

  // watch the progress pill fill, then complete
  await p1.waitForFunction(() => _cacheStatus.state === 'complete', { timeout: 15000 });
  const pill = await p1.evaluate(() => {
    const el = document.getElementById('cache-status');
    return { text: el ? el.textContent : null, status: JSON.stringify(_cacheStatus) };
  });

  // every active lot cached? (none were manually opened)
  const coverage = await p1.evaluate(async (n) => {
    let cached = 0, notesCached = 0;
    for (let k=1;k<=n;k++){
      const t = await OfflineData.get('getScheduleLotTasks', { lot_id:'L'+k });
      const nt = await OfflineData.get('getTaskNotes', { lot_id:'L'+k });
      if (t && t.tasks && t.tasks.length) cached++;
      if (Array.isArray(nt) && nt.length) notesCached++;
    }
    const closed = await OfflineData.get('getScheduleLotTasks', { lot_id:'Lclosed' });
    return { cached, notesCached, closedCached: !!closed };
  }, N);

  const firstFew = taskReqOrder.slice(0, 3);

  // ── TRUE OFFLINE: server DOWN, open a lot never manually opened ──
  await context.setOffline(true);
  await new Promise(r => server.close(r)); server.closeAllConnections && server.closeAllConnections();
  const offline = await p1.evaluate(async () => {
    _isOnline = false;
    await openLot('L37');                            // never opened by hand this session
    return { curLotId: curLot && curLot.id, taskCount: (typeof TASKS!=='undefined'?TASKS.length:-1),
             notes: (typeof lotNotes!=='undefined'?lotNotes.length:-1) };
  });

  // ── HONESTY: the paused-mid-fill pill shows the TRUE partial count ──
  const pausedPill = await p1.evaluate(() => {
    _cacheStatus = { total: 50, done: 23, state: 'paused' };   // as the loop sets it when signal drops
    updateCacheStatus();
    const el = document.getElementById('cache-status');
    return el ? el.textContent : null;
  });

  console.log('\n===== Layer 4b — background territory prefetch (50 lots) =====\n');
  console.log('  login (ms, should be small): ' + Math.round(immediate.loginMs) + '   list=' + immediate.listCount + '   cacheState@login=' + immediate.cacheStateRightAfterLogin);
  console.log('  progress pill (final): ' + pill.text + '   ' + pill.status);
  console.log('  task-fetch order (first 3): ' + JSON.stringify(firstFew) + '   (expect L50,L49,L48 — recently-active first)');
  console.log('  coverage: ' + JSON.stringify(coverage));
  console.log('  offline open of never-opened L37: ' + JSON.stringify(offline));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  check('app usable immediately: list rendered (>=50 lots)', listCount >= 50);
  check('fill ran in BACKGROUND (login returned before the fill completed)',
    immediate.cacheStateRightAfterLogin !== 'complete');
  check('progress pill ended at "✓ 50 lots ready offline"', /✓ 50 lots ready offline/.test(pill.text || ''));
  check('priority = recently-active first (L50, L49, L48 cached first)',
    firstFew[0]==='L50' && firstFew[1]==='L49' && firstFew[2]==='L48');
  check('ALL 50 active lots\' tasks cached (none manually opened)', coverage.cached === 50);
  check('ALL 50 active lots\' notes cached', coverage.notesCached === 50);
  check('closed/archived lot was SKIPPED (not cached)', coverage.closedCached === false);
  check('OFFLINE (server down): a never-opened lot OPENS from cache', offline.curLotId === 'L37' && offline.taskCount >= 1);
  check('OFFLINE: that lot\'s cached notes are present', offline.notes >= 1);
  check('honesty: paused-mid-fill pill shows the true partial count ("⚠ 23/50 lots cached")',
    /⚠ 23\/50 lots cached/.test(pausedPill || ''));

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  try { server.close(); } catch(e){}
  process.exit(allPass ? 0 : 1);
})();
