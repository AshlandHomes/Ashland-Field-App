'use strict';
// After a sync, the STORED reported_stage (the lot-list badge) must be recomputed for
// EVERY lot whose task/gate actions synced — not just the open lot. Repro: the builder
// completes the SOURCE lot's tasks offline and pushes to others, then syncs from the lot
// LIST. The push writes each TARGET's reported_stage, but the SOURCE relied on the old
// curLot-only recompute and its list badge stayed stale (in-lot badge was live-correct).
// This runs the REAL recomputeDerivedAfterSync + recomputeAndPersistLotStage.
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const CODE = html.slice(html.indexOf('async function recomputeDerivedAfterSync(results){'),
                        html.indexOf('// Reconcile a note created OFFLINE'));

const STAGES = [
  {code:'6.0',label:'Six',   order:60, is_manual:false, triggers:[60]},
  {code:'7.0',label:'Seven', order:70, is_manual:false, triggers:[70]},
  {code:'8.0',label:'Eight', order:80, is_manual:false, triggers:[80]},
];

function run(sourceRows){
  const calls = [];
  async function sbCallRaw(action, payload){
    calls.push({action, payload});
    if (action==='getScheduleLotTasks') return { tasks: sourceRows, gates: [] };
    if (action==='getTemplateStageMap') return { stages: STAGES };
    if (action==='updateScheduleLot')   return { ok:true };
    return {};
  }
  // queued actions: Lot 10's task finishes (synced) — Lot 10 is NOT the open lot.
  const queue = [
    { id:'q1', apiAction:'updateScheduleLotTask', target:{lot_id:'L10', bt_num:60} },
    { id:'q2', apiAction:'updateScheduleLotTask', target:{lot_id:'L10', bt_num:70} },
    { id:'q3', apiAction:'updateScheduleLotTask', target:{lot_id:'L10', bt_num:80} },
    { id:'qp', kind:'push_lot', apiAction:'__push_lot', target:{lot_id:'L11', lot_number:'11'} }, // push target — NOT a task action
  ];
  const results = { q1:{}, q2:{}, q3:{}, qp:{done:3} };   // all synced
  const ctx = {
    OfflineQueue: { getAll: async () => queue.slice() },
    sbCallRaw, ScheduleEngine: SE, console, Promise,
    curLot: null,                                          // builder is on the LOT LIST, not inside L10
    myLots: [{ id:'L10', template_id:'TPL', manual_stage:null }, { id:'L11', template_id:'TPL', manual_stage:null }],
    checkCompletionStamp: async () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.__recompute = recomputeDerivedAfterSync;', ctx);
  return { ctx, calls, results };
}

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

(async()=>{
  // Lot 10 (the SOURCE) is finished all the way to stage 8, but it is NOT the open lot.
  const allFinished = [
    {bt_num:60, status:'finished'}, {bt_num:70, status:'finished'}, {bt_num:80, status:'finished'},
  ];
  const { ctx, calls, results } = run(allFinished);
  await ctx.__recompute(results);

  const upd = calls.find(c => c.action==='updateScheduleLot');
  is('recomputes+persists the SOURCE lot (L10) even though it is not the open lot', !!upd, true);
  is('    writes it to L10', upd && upd.payload.id, 'L10');
  is('    reported_stage recomputed to 8.0 (matches the in-lot badge)', upd && upd.payload.reported_stage, '8.0');
  is('    re-read L10 live (not trusting stale memory)', !!calls.find(c=>c.action==='getScheduleLotTasks' && c.payload.lot_id==='L10'), true);

  // The push TARGET (L11) must NOT be recomputed here — the push executor already wrote
  // its reported_stage; its queued action is push_lot, not a task action.
  const touchedL11 = calls.some(c => (c.action==='updateScheduleLot' && c.payload.id==='L11')
                                   || (c.action==='getScheduleLotTasks' && c.payload.lot_id==='L11'));
  is('does NOT re-touch the push target L11 (already written by the push)', touchedL11, false);

  // A lot only partially finished must persist the LOWER stage, not the top.
  const { ctx:c2, calls:calls2, results:r2 } = run([
    {bt_num:60, status:'finished'}, {bt_num:70, status:'not_started'}, {bt_num:80, status:'not_started'},
  ]);
  await c2.__recompute(r2);
  const upd2 = calls2.find(c => c.action==='updateScheduleLot');
  is('partial completion persists the correct lower stage (6.0)', upd2 && upd2.payload.reported_stage, '6.0');

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
