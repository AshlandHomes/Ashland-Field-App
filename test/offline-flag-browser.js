/*
 * Offline NOTE-FLAG proof (fix #2 of the silent-loss four) — incl. the client-id wrinkle.
 * ---------------------------------------------------------------------------
 * cycleNoteFlag was a direct sbCall — a lost flag = a MISSED admin escalation. Now it
 * routes through the durable queue. Two genuinely different cases:
 *   CASE 1 — flag a SERVER note offline: straightforward; queues against the real id,
 *            drains against it.
 *   CASE 2 (HARD) — flag an OFFLINE-CREATED note offline: the note's local id is only a
 *            CLIENT id (its addTaskNote hasn't synced). On reconnect the note is created
 *            FIRST (addTaskNote → server id), reconciliation rewrites the pending flag
 *            action's target id to the server id, THEN the flag drains against it. No
 *            orphaned flag, no flag hitting an unknown id.
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

  // ── CASE 1: flag a SERVER note offline ──
  const c1 = await page.evaluate(async () => {
    await OfflineQueue._clearAll();
    currentBuilder='Marisa'; curLot={id:'L1',lot_number:'12'};
    lotNotes=[{id:'srv-note-1', lot_task_id:'t1', lot_id:'L1', bt_num:84, note:'Leak', flag:'none', author:'Marisa'}];
    renderThread=()=>{}; renderTasks=()=>{}; renderSchedule=()=>{}; renderFlagBtns=()=>{}; saveStage=async()=>{}; checkCompletionStamp=async()=>{};
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload}); return {}; };

    _isOnline=false; probeConnectivity=async()=>false;
    await cycleNoteFlag('srv-note-1');           // none -> yellow, offline
    const offline={ pending:(await OfflineQueue.summary()).pending, drainAttempts:raws.length, localFlag:lotNotes[0].flag };

    probeConnectivity=async()=>true; _isOnline=true;
    await syncQueue();
    const replay=raws.find(r=>r.action==='updateTaskNote');
    return { offline, synced:(await OfflineQueue.summary()).synced,
      replayId:replay&&replay.payload.id, replayFlag:replay&&replay.payload.flag };
  });

  // ── CASE 2 (HARD): create a note offline, flag it offline, reconnect ──
  const c2 = await page.evaluate(async () => {
    await OfflineQueue._clearAll();
    currentBuilder='Marisa'; noteTaskNum=84; noteFlag='none';
    curLot={id:'L1',lot_number:'12'}; bn={84:{_id:'t84',num:84,name:'Trim'}}; lotNotes=[];
    renderThread=()=>{}; renderTasks=()=>{}; renderSchedule=()=>{}; renderFlagBtns=()=>{}; saveStage=async()=>{}; checkCompletionStamp=async()=>{};
    document.getElementById('note-text').value='Cracked slab';
    const m=document.getElementById('note-multi'); if(m) m.checked=false;

    // OFFLINE: add the note, then flag it red-ish (none->yellow)
    _isOnline=false; probeConnectivity=async()=>false;
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload});
      if(action==='addTaskNote') return [{id:'srv-note-9', flag:payload.flag}]; return {}; };
    await addNote();
    const clientId=lotNotes[0].id;                 // note's local id == addTaskNote client action id
    await cycleNoteFlag(clientId);                  // flag the OFFLINE note (targets the client id)
    const all=await OfflineQueue.getAll();
    const noteAct=all.find(a=>a.apiAction==='addTaskNote');
    const flagAct=all.find(a=>a.apiAction==='updateTaskNote');
    const offline={ pending:(await OfflineQueue.summary()).pending,
      clientId, flagTargetsClientId: !!(flagAct && flagAct.payload.id===clientId),
      noteBeforeFlag: !!(noteAct && flagAct && noteAct.seq < flagAct.seq) };

    // RECONNECT: note created first (server id), flag rewired to server id, then drains
    probeConnectivity=async()=>true; _isOnline=true;
    await syncQueue();
    const order=raws.map(r=>r.action);
    const flagReplay=raws.find(r=>r.action==='updateTaskNote');
    return { offline, summary:await OfflineQueue.summary(), order,
      flagReplayId: flagReplay && flagReplay.payload.id,
      flagReplayFlag: flagReplay && flagReplay.payload.flag,
      localNoteId: lotNotes[0] && lotNotes[0].id };
  });

  console.log('\n===== Offline note-flag (real cycleNoteFlag) =====\n');
  console.log('  CASE 1 (server note):  ' + JSON.stringify(c1));
  console.log('  CASE 2 (offline note): ' + JSON.stringify(c2));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  // case 1
  check('C1 OFFLINE: flag queued (1 pending), drain skipped, local flag=yellow', c1.offline.pending===1 && c1.offline.drainAttempts===0 && c1.offline.localFlag==='yellow');
  check('C1 RECONNECT: flag drained against the real server id', c1.synced===1 && c1.replayId==='srv-note-1' && c1.replayFlag==='yellow');
  // case 2 — the hard case
  check('C2 OFFLINE: both note+flag queued (2 pending)', c2.offline.pending===2);
  check('C2 OFFLINE: flag targets the note\'s CLIENT id (no server id yet)', c2.offline.flagTargetsClientId===true);
  check('C2 OFFLINE: note is ordered BEFORE its flag (created first on replay)', c2.offline.noteBeforeFlag===true);
  check('C2 RECONNECT: replayed addTaskNote THEN updateTaskNote, in order', JSON.stringify(c2.order)===JSON.stringify(['addTaskNote','updateTaskNote']));
  check('C2 RECONNECT: the flag landed on the real SERVER id (rewired from client id)', c2.flagReplayId==='srv-note-9' && c2.flagReplayId!==c2.offline.clientId);
  check('C2 RECONNECT: flag value preserved (yellow)', c2.flagReplayFlag==='yellow');
  check('C2 RECONNECT: both synced, none failed (no orphaned flag)', c2.summary.synced===2 && c2.summary.failed===0);
  check('C2 RECONNECT: local note id reconciled to the server id', c2.localNoteId==='srv-note-9');

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
