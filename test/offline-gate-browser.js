/*
 * Offline UTILITY GATES proof — toggling a gate works with no signal.
 * ---------------------------------------------------------------------------
 * A utility gate toggle is a SIMPLE write (a boolean on an existing gate row), so it
 * now routes through the durable queue like start/finish. This drives the REAL
 * toggleGate() inside the field app and proves:
 *   OFFLINE  -> the toggle enqueues, drain is SKIPPED, the gate flips locally (UI
 *              succeeds optimistically), status shows offline.
 *   RECONNECT-> drain replays the real updateScheduleLotGate; the derived reported_stage
 *              (saveStage) is recomputed EXACTLY once; status shows synced.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ashland-stage-update-dev.html'), 'utf8');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.indexOf('/.netlify/functions/config') === 0){ res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ secret:'' })); }
    if (u.indexOf('/.netlify/functions/') === 0){ res.setHeader('Content-Type','application/json'); return res.end('[]'); }
    if (u === '/' || u === ''){ res.setHeader('Content-Type','text/html'); return res.end(HTML); }
    const f = path.join(ROOT, u.replace(/^\//,''));
    if (f.indexOf(ROOT) === 0 && fs.existsSync(f) && fs.statSync(f).isFile()){
      const ext = path.extname(f);
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':(ext==='.json'?'application/json':'text/plain'));
      return res.end(fs.readFileSync(f));
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200); errors.length = 0;

  const out = await page.evaluate(async () => {
    await OfflineQueue._clearAll();
    currentBuilder='Marisa'; curLot={id:'L1',lot_number:'12',builder_name:'Marisa'};
    lotGates=[{id:'gate-7', gate_name:'Power', confirmed:false}];
    TASKS=[{_id:'t1',num:84,name:'Trim'}]; bn={84:TASKS[0]}; act={84:{started:true,finished:false}};
    window.__saveStage=0;
    saveStage=async()=>{ window.__saveStage++; }; checkCompletionStamp=async()=>{};
    renderSchedule=()=>{}; renderTasks=()=>{}; renderThread=()=>{};
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload}); return {}; };

    // ── OFFLINE: toggle the gate ──
    _isOnline=false; probeConnectivity=async()=>false;
    await toggleGate('gate-7', false);          // confirm the Power gate with no signal
    const offline={ summary:await OfflineQueue.summary(), drainAttempts:raws.length,
      gateConfirmedLocally:lotGates[0].confirmed, status:document.getElementById('sync-status').textContent };

    // ── RECONNECT ──
    probeConnectivity=async()=>true;
    await syncQueue();
    const online={ summary:await OfflineQueue.summary(), rawActions:raws.map(r=>r.action),
      gatePayload:raws.find(r=>r.action==='updateScheduleLotGate'), saveStageCalls:window.__saveStage,
      status:document.getElementById('sync-status').textContent };

    return { offline, online };
  });

  console.log('\n===== Offline utility gates (real toggleGate) =====\n');
  console.log('  OFFLINE:   ' + JSON.stringify(out.offline));
  console.log('  RECONNECT: ' + JSON.stringify(out.online));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  check('OFFLINE: gate toggle queued (1 pending, 0 synced)', out.offline.summary.pending===1 && out.offline.summary.synced===0);
  check('OFFLINE: drain SKIPPED (no backend call attempted)', out.offline.drainAttempts===0);
  check('OFFLINE: gate flipped locally (UI succeeded optimistically)', out.offline.gateConfirmedLocally===true);
  check('OFFLINE: status shows offline + queued', /offline/.test(out.offline.status) && /1 queued/.test(out.offline.status));
  check('RECONNECT: drained -> 1 synced, 0 pending, 0 failed',
    out.online.summary.synced===1 && out.online.summary.pending===0 && out.online.summary.failed===0);
  check('RECONNECT: replayed the real updateScheduleLotGate endpoint', out.online.rawActions.includes('updateScheduleLotGate'));
  check('RECONNECT: replayed with confirmed=true for gate-7',
    !!out.online.gatePayload && out.online.gatePayload.payload.gate_id==='gate-7' && out.online.gatePayload.payload.confirmed===true);
  check('RECONNECT: derived reported_stage (saveStage) recomputed EXACTLY once', out.online.saveStageCalls===1);
  check('RECONNECT: status is quiet "✓ synced"', /✓ synced/.test(out.online.status));

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
