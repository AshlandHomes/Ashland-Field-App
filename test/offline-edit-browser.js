/*
 * Offline TASK-EDIT proof (fix #4 of the silent-loss four).
 * ---------------------------------------------------------------------------
 * saveEditTask persists a task edit as TWO writes (editLotTask = structure, then
 * updateScheduleLotTask = est_start_date override). They were direct sbCalls: offline
 * the first threw → button stuck "Saving…" + DB write silently lost. Now routed as an
 * ORDERED pair through the durable queue. Proves:
 *   OFFLINE  -> both writes queue (2 pending), drain skipped, structure BEFORE est,
 *              and the modal closes cleanly (no stuck "Saving…").
 *   RECONNECT-> drains editLotTask THEN updateScheduleLotTask; both land; nothing lost.
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
    const iso = off => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+off);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
    const cs = iso(-60);
    currentBuilder='Marisa';
    curLot={id:'L1',lot_number:'12',builder_name:'Marisa',construction_start_date:cs};
    // two-task chain so #200 has a predecessor and a valid edit
    TASKS=[
      {_id:'t100',num:100,name:'Anchor',rs:1,dur:1,lag:0,rf:1,preds:[],phase:1,phase_name:'P',type:'work',order:1,est_start_date:null,is_crit:true,note:'',flag:'none'},
      {_id:'t200',num:200,name:'Trim',rs:2,dur:3,lag:0,rf:4,preds:[100],phase:1,phase_name:'P',type:'work',order:2,est_start_date:null,is_crit:true,note:'',flag:'none'},
    ];
    bn={}; TASKS.forEach(x=>bn[x.num]=x);
    act={100:{started:true,finished:true,start:cs,finish:cs},200:{started:false,finished:false,start:null,finish:null}};
    startDate=new Date(cs+'T00:00:00'); stageMap=[]; lotGates=[]; lotNotes=[];
    collapsedPhases={}; userToggledPhases=true;
    saveStage=async()=>{}; checkCompletionStamp=async()=>{}; appModal=async()=>true;
    renderSchedule();                                   // engine run → projected offsets for the est prefill/guard

    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload}); return {}; };

    // open the editor for #200 and change duration 3 -> 5 (no est override change)
    openEditTask(200);
    document.getElementById('edit-dur').value='5';
    // leave est-start at its prefill (no override) so newEstStart stays null

    // ── OFFLINE: save the edit ──
    _isOnline=false; probeConnectivity=async()=>false;
    await saveEditTask();
    const all=await OfflineQueue.getAll();
    const editA=all.find(a=>a.apiAction==='editLotTask');
    const estA=all.find(a=>a.apiAction==='updateScheduleLotTask');
    const modalOpen=document.getElementById('edit-modal') && document.getElementById('edit-modal').style.display!=='none';
    const btn=document.getElementById('edit-save-btn');
    const offline={ pending:(await OfflineQueue.summary()).pending, drainAttempts:raws.length,
      hasEdit:!!editA, hasEst:!!estA, structureBeforeEst:!!(editA&&estA&&editA.seq<estA.seq),
      editDur:editA&&editA.payload.duration, memDur:bn[200].dur,
      btnText:btn?btn.textContent:null, btnDisabled:btn?btn.disabled:null };

    // ── RECONNECT ──
    probeConnectivity=async()=>true; _isOnline=true;
    await syncQueue();
    const order=raws.map(r=>r.action).filter(a=>a==='editLotTask'||a==='updateScheduleLotTask');
    const online={ summary:await OfflineQueue.summary(), order,
      editReplay:raws.find(r=>r.action==='editLotTask') };
    return { offline, online };
  });

  console.log('\n===== Offline task-edit (real saveEditTask) =====\n');
  console.log('  OFFLINE:   ' + JSON.stringify(out.offline));
  console.log('  RECONNECT: ' + JSON.stringify(out.online));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  check('OFFLINE: both writes queued (2 pending)', out.offline.pending===2 && out.offline.hasEdit && out.offline.hasEst);
  check('OFFLINE: drain SKIPPED', out.offline.drainAttempts===0);
  check('OFFLINE: structure (editLotTask) ordered BEFORE est (updateScheduleLotTask)', out.offline.structureBeforeEst===true);
  check('OFFLINE: the edit is durable (duration 5 queued + applied in memory)', out.offline.editDur===5 && out.offline.memDur===5);
  check('OFFLINE: no stuck "Saving…" — button reset + modal closed', out.offline.btnDisabled===false && !/Saving/.test(out.offline.btnText||'') && !out.offline.modalOpen);
  check('RECONNECT: both drained (0 pending, 0 failed)', out.online.summary.pending===0 && out.online.summary.failed===0 && out.online.summary.synced===2);
  check('RECONNECT: replayed editLotTask THEN updateScheduleLotTask, in order', JSON.stringify(out.online.order)===JSON.stringify(['editLotTask','updateScheduleLotTask']));
  check('RECONNECT: structure edit reached backend (duration 5)', !!out.online.editReplay && out.online.editReplay.payload.duration===5);

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
