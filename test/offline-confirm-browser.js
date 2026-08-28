/*
 * Offline VENDOR-CONFIRM proof (fix #3 of the silent-loss four).
 * ---------------------------------------------------------------------------
 * toggleConfirm flips a task's vendor_confirmed ✓. It was a direct sbCall — the UI
 * showed the checkmark while the write was silently lost offline / on a blip. Now it
 * routes through the durable queue (a partial updateScheduleLotTask). Proves:
 *   OFFLINE  -> queues, drain skipped, the ✓ flips locally.
 *   RECONNECT-> drains updateScheduleLotTask with vendor_confirmed:true; nothing lost.
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
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':'text/plain');
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
    currentBuilder='Marisa'; curLot={id:'L1',lot_number:'12'};
    const t={_id:'t84',num:84,name:'Trim'}; bn={84:t}; TASKS=[t];
    act={84:{started:true,finished:false,vendor_confirmed:false}};
    renderTasks=()=>{}; renderSchedule=()=>{}; saveStage=async()=>{}; checkCompletionStamp=async()=>{};
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload}); return {}; };

    // ── OFFLINE: confirm the vendor ──
    _isOnline=false; probeConnectivity=async()=>false;
    await toggleConfirm(84);
    const offline={ summary:await OfflineQueue.summary(), drainAttempts:raws.length,
      confirmedLocally:act[84].vendor_confirmed, status:document.getElementById('sync-status').textContent };

    // ── RECONNECT ──
    probeConnectivity=async()=>true; _isOnline=true;
    await syncQueue();
    const replay=raws.find(r=>r.action==='updateScheduleLotTask');
    const online={ summary:await OfflineQueue.summary(), replay: replay&&replay.payload,
      status:document.getElementById('sync-status').textContent };
    return { offline, online };
  });

  console.log('\n===== Offline vendor-confirm (real toggleConfirm) =====\n');
  console.log('  OFFLINE:   ' + JSON.stringify(out.offline));
  console.log('  RECONNECT: ' + JSON.stringify(out.online));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  check('OFFLINE: confirm queued (1 pending, 0 synced)', out.offline.summary.pending===1 && out.offline.summary.synced===0);
  check('OFFLINE: drain SKIPPED (no backend call)', out.offline.drainAttempts===0);
  check('OFFLINE: ✓ flipped locally (UI optimistic)', out.offline.confirmedLocally===true);
  check('OFFLINE: status shows offline + queued', /offline/.test(out.offline.status) && /1 queued/.test(out.offline.status));
  check('RECONNECT: drained -> 1 synced, 0 pending, 0 failed', out.online.summary.synced===1 && out.online.summary.pending===0 && out.online.summary.failed===0);
  check('RECONNECT: replayed updateScheduleLotTask with vendor_confirmed:true (partial, no status)',
    !!out.online.replay && out.online.replay.vendor_confirmed===true && out.online.replay.status===undefined);
  check('RECONNECT: status is quiet "✓ synced"', /✓ synced/.test(out.online.status));

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
