/*
 * Layer 3 proof: online/offline detection + deferred sync, in the REAL field app.
 *  OFFLINE  -> builder actions enqueue and the drain is SKIPPED (stay pending); UI
 *              still "succeeds" (note uses the client action id). Status shows offline.
 *  RECONNECT-> drain in order -> synced; DERIVED recompute (saveStage) runs; the
 *              offline note's id reconciles to the server id. Status shows synced.
 *  SERVER ERR-> a reachable backend returning {error} marks the action FAILED
 *              (surfaced, never dropped). Status shows failed.
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
    if (u.indexOf('/.netlify/functions/config') === 0) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ secret: '' })); }
    if (u.indexOf('/.netlify/functions/') === 0) { res.setHeader('Content-Type','application/json'); return res.end('[]'); }
    if (u === '/' || u === '') { res.setHeader('Content-Type','text/html'); return res.end(HTML); }
    const f = path.join(ROOT, u.replace(/^\//,''));
    if (f.indexOf(ROOT) === 0 && fs.existsSync(f) && fs.statSync(f).isFile()) {
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
    // seed + isolate UI/derived
    currentBuilder='Marisa'; curLot={id:'L1',lot_number:'12',builder_name:'Marisa'};
    const t={_id:'task-1',num:84,name:'Trim'}; bn={84:t}; TASKS=[t]; lotNotes=[];
    window.__saveStage=0;
    saveStage=async()=>{ window.__saveStage++; }; checkCompletionStamp=async()=>{};
    renderThread=()=>{}; renderFlagBtns=()=>{}; renderTasks=()=>{}; renderSchedule=()=>{};
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload});
      if(action==='addTaskNote') return [{id:'srv-note-9',flag:payload.flag}]; return {}; };

    // ── OFFLINE ──
    _isOnline=false; probeConnectivity=async()=>false;
    act={84:{started:true,finished:false,start:'2026-08-27',finish:null}}; await saveTask(t);   // start
    noteTaskNum=84; noteFlag='red'; document.getElementById('note-text').value='Leak'; await addNote();  // note
    const offline={ summary:await OfflineQueue.summary(), status:document.getElementById('sync-status').textContent,
      drainAttempts:raws.length, noteId:lotNotes[0] && lotNotes[0].id };

    // ── RECONNECT ──
    probeConnectivity=async()=>true;
    await syncQueue();
    const online={ summary:await OfflineQueue.summary(), status:document.getElementById('sync-status').textContent,
      noteId:lotNotes[0] && lotNotes[0].id, saveStageCalls:window.__saveStage, rawActions:raws.map(r=>r.action) };

    // ── SERVER ERROR (reachable backend returns {error}) ──
    sbCallRaw=async()=>({error:'boom'});
    act={84:{started:true,finished:true,start:'2026-08-27',finish:'2026-08-28'}}; await saveTask(t);  // finish -> fails
    const failed={ summary:await OfflineQueue.summary(), status:document.getElementById('sync-status').textContent };

    return { offline, online, failed };
  });

  console.log('\n===== Layer 3 — offline detection + deferred sync (real field app) =====\n');
  console.log('  OFFLINE:   ' + JSON.stringify(out.offline));
  console.log('  RECONNECT: ' + JSON.stringify(out.online));
  console.log('  SRV ERROR: ' + JSON.stringify(out.failed));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  // offline: enqueued, drain SKIPPED, UI succeeded
  check('OFFLINE: 2 actions queued (pending), 0 synced', out.offline.summary.pending===2 && out.offline.summary.synced===0);
  check('OFFLINE: drain was SKIPPED (no backend calls attempted)', out.offline.drainAttempts===0);
  check('OFFLINE: note used the client action id (no server round-trip)', /^a_|-/.test(out.offline.noteId||'') && out.offline.noteId!=='srv-note-9');
  check('OFFLINE: status shows offline + queued count', /offline/.test(out.offline.status) && /2 queued/.test(out.offline.status));
  // reconnect: drained, derived recompute, note reconciled
  check('RECONNECT: all drained -> 2 synced, 0 pending, 0 failed',
    out.online.summary.synced===2 && out.online.summary.pending===0 && out.online.summary.failed===0);
  check('RECONNECT: derived side-effects recomputed EXACTLY once (no double-write)', out.online.saveStageCalls===1);
  check('RECONNECT: offline note id reconciled to the server id', out.online.noteId==='srv-note-9');
  check('RECONNECT: replayed the real endpoints', out.online.rawActions.includes('updateScheduleLotTask') && out.online.rawActions.includes('addTaskNote'));
  check('RECONNECT: status is quiet "✓ synced"', /✓ synced/.test(out.online.status));
  // server error: surfaced, not dropped
  check('SERVER ERROR: action marked failed (surfaced, not dropped)', out.failed.summary.failed===1);
  check('SERVER ERROR: status shows "⚠ N failed" (loud)', /failed/.test(out.failed.status));

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
