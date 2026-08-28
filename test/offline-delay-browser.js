/*
 * Offline DELAY-REASON proof (fix #1 of the silent-loss four).
 * ---------------------------------------------------------------------------
 * Finishing a LATE critical task captures a delay reason. That reason used to be a
 * direct sbCall in a try/catch — dropped SILENTLY offline while the finish survived.
 * Now it routes through the durable queue, enqueued right AFTER the finish. Proves:
 *   OFFLINE  -> BOTH the finish AND the delay reason queue (2 pending), drain skipped,
 *              the finish's seq < the delay's seq (reason drains WITH/after its finish).
 *   RECONNECT-> both drain: updateScheduleLotTask THEN addTaskDelay, in order; the delay
 *              payload carries the reason + the right task ids. Nothing dropped.
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
    const today = iso(0), cs = iso(-120);
    currentBuilder='Marisa'; curLot={id:'L1',lot_number:'12',builder_name:'Marisa',community:'CO',construction_start_date:cs,completion_stamped_at:null};
    // #100 anchor (finished) -> #113 critical, projected finish in the PAST so today is LATE
    TASKS=[
      {_id:'t100',num:100,name:'Anchor',rs:1,dur:1,lag:0,rf:1,preds:[],phase:1,phase_name:'P',type:'work',order:1,est_start_date:null,is_crit:true,note:'',flag:'none'},
      {_id:'t113',num:113,name:'Trim',rs:2,dur:1,lag:0,rf:2,preds:[100],phase:1,phase_name:'P',type:'work',order:2,est_start_date:null,is_crit:true,note:'',flag:'none'},
    ];
    bn={}; TASKS.forEach(x=>bn[x.num]=x);
    act={100:{started:true,finished:true,start:cs,finish:cs,vendor_confirmed:false},
         113:{started:true,finished:false,start:iso(-10),finish:null,vendor_confirmed:false}};
    startDate=new Date(cs+'T00:00:00'); stageMap=[]; lotGates=[]; lotNotes=[];
    collapsedPhases={}; userToggledPhases=true;
    _drReasons=[{id:'r1',label:'Weather'}];             // reasons cached (offline-ready)
    saveStage=async()=>{}; checkCompletionStamp=async()=>{};
    renderSchedule();                                   // REAL engine run -> sets _crit + _projected_ef
    // auto-answer the modals: finish "today", pick reason "Weather"
    appModal=async({title})=>{ if(/^Finish /.test(title)) return 'today'; return null; };
    openDelayReasonModal=async()=>({id:'r1',label:'Weather',note:'roof'});
    const raws=[]; sbCallRaw=async(action,payload)=>{ raws.push({action,payload}); return {}; };

    // ── OFFLINE: finish the late critical task ──
    _isOnline=false; probeConnectivity=async()=>false;
    await finishTask(113);
    const all=await OfflineQueue.getAll();
    const finA=all.find(a=>a.apiAction==='updateScheduleLotTask');
    const delA=all.find(a=>a.apiAction==='addTaskDelay');
    const offline={ summary:await OfflineQueue.summary(), drainAttempts:raws.length,
      hasFinish:!!finA, hasDelay:!!delA, orderedFinishBeforeDelay:!!(finA&&delA&&finA.seq<delA.seq),
      delayReason:delA&&delA.payload&&delA.payload.reason_label, delayTask:delA&&delA.payload&&delA.payload.bt_num };

    // ── RECONNECT ──
    probeConnectivity=async()=>true;
    await syncQueue();
    const drainedOrder=raws.map(r=>r.action).filter(a=>a==='updateScheduleLotTask'||a==='addTaskDelay');
    const online={ summary:await OfflineQueue.summary(), drainedOrder,
      delayReplay:raws.find(r=>r.action==='addTaskDelay') };
    return { offline, online };
  });

  console.log('\n===== Offline delay-reason (real finishTask, late critical) =====\n');
  console.log('  OFFLINE:   ' + JSON.stringify(out.offline));
  console.log('  RECONNECT: ' + JSON.stringify(out.online));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  check('OFFLINE: BOTH finish and delay queued (2 pending, 0 synced)', out.offline.summary.pending===2 && out.offline.summary.synced===0);
  check('OFFLINE: drain SKIPPED (no backend call)', out.offline.drainAttempts===0);
  check('OFFLINE: the delay reason is DURABLE (queued, not dropped)', out.offline.hasDelay===true && out.offline.delayReason==='Weather');
  check('OFFLINE: delay is linked to the finished task (#113)', out.offline.delayTask===113);
  check('OFFLINE: finish is ordered BEFORE its delay (seq)', out.offline.orderedFinishBeforeDelay===true);
  check('RECONNECT: both drained (0 pending, 0 failed)', out.online.summary.pending===0 && out.online.summary.failed===0 && out.online.summary.synced===2);
  check('RECONNECT: replayed finish THEN delay, in order', JSON.stringify(out.online.drainedOrder)===JSON.stringify(['updateScheduleLotTask','addTaskDelay']));
  check('RECONNECT: delay reason reached the backend (Weather)', !!out.online.delayReplay && out.online.delayReplay.payload.reason_label==='Weather');

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
