'use strict';
// COLLIN'S EXACT REPRO: Lot 10 has all tasks finished (task-wise stage 7.0), but a manual
// UTILITY GATE at threshold 5.9 was UNCHECKED (confirmed=false) → its reported stage is
// capped to 5.9. He pushes "entire lot status" to Lots 11 & 12 and expects them to drop 7→5.9.
//
// This runs the REAL executePushLot against a target whose gate is still RELEASED
// (confirmed=true), exactly like an untouched Lot 11/12. It answers, with data:
//   (1) Do the pushed TASK statuses actually get written to the target?  (is the sync broken?)
//   (2) Does the target's recomputed stage drop to 5.9?                  (does the gate transfer?)
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const CODE = html.slice(html.indexOf('async function executePushLot(a){'), html.indexOf('// Reconnect-drain report'));

// A stage map that reaches 7.0 when its trigger tasks are finished.
const STAGES = [
  {code:'5.9',label:'Utilities', order:59, is_manual:false, triggers:[50]},
  {code:'6.0',label:'Trim',      order:60, is_manual:false, triggers:[60]},
  {code:'7.0',label:'Complete',  order:70, is_manual:false, triggers:[70]},
];
// The target lot's tasks — all present, currently not started.
const TARGET_ROWS = [
  {bt_num:50, id:'T50', status:'not_started', actual_start:null, actual_finish:null},
  {bt_num:60, id:'T60', status:'not_started', actual_start:null, actual_finish:null},
  {bt_num:70, id:'T70', status:'not_started', actual_start:null, actual_finish:null},
];
// The pushed source status: EVERYTHING finished (Lot 10 is task-complete; only the gate holds it).
const PUSHED = [
  {bt_num:50, status:'finished', actual_start:'2026-09-01', actual_finish:'2026-09-02'},
  {bt_num:60, status:'finished', actual_start:'2026-09-03', actual_finish:'2026-09-04'},
  {bt_num:70, status:'finished', actual_start:'2026-09-05', actual_finish:'2026-09-06'},
];
// The utility gate, threshold 5.9, MANUAL (no hold tasks). MATCHED across lots by
// source_gate_id (the shared template gate); `id` is the per-lot gate-state row
// (the updateScheduleLotGate target). `confirmed` set per scenario.
function gate(confirmed){ return { id:'GS11', source_gate_id:'SG1', gate_name:'Utility Hold', hold_stage_code:'5.9', hold_task_bt_nums:[], confirmed:confirmed, status_message:'Waiting on utility' }; }

// pushGate: when set, the intent carries the source's frozen manual gate state.
function run(targetGateConfirmed, pushGate){
  const calls = [];
  async function sbCallRaw(action, payload){
    calls.push({action, payload});
    if (action==='getScheduleLotTasks')   return { tasks: TARGET_ROWS, gates: [gate(targetGateConfirmed)] };
    if (action==='getTemplateStageMap')   return { stages: STAGES };
    if (action==='bulkUpdateLotTasks')    return { done:(payload.updates||[]).length, failed:[] };
    if (action==='updateScheduleLotGate') return [{ id:payload.gate_id, confirmed:payload.confirmed }];
    if (action==='getDelaysForLot')       return [];
    return {};
  }
  const ctx = { sbCallRaw, ScheduleEngine:SE, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.__exec = executePushLot;', ctx);
  const intent = { kind:'push_lot', mode:'lot', source_lot_id:'L10', source_lot_number:'10', builder:'Matt',
    pushed:PUSHED, note:null, delays:[],
    gates: pushGate ? [{ source_gate_id:'SG1', gate_name:'Utility Hold', confirmed:false }] : undefined,
    target:{lot_id:'L11', lot_number:'11', community:'CT', template_id:'TPL'} };
  return { ctx, calls, intent };
}

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

// NOTE: since the single-source refactor, the push does NOT write reported_stage — the
// stage is COMPUTED on read in getScheduleLots. So the "target drops to 5.9" proof now
// lives in test/getschedulelots-compute.js (a held manual gate -> capped stage). What the
// push is responsible for is PROPAGATING the source's gate state onto the target; that is
// what this test proves (plus that it no longer writes any stage).
(async()=>{
  console.log('\n── RUN A: push does NOT carry a gate change -> only task statuses written ──');
  {
    const {ctx, calls, intent} = run(true, false);   // target gate released; intent carries NO gates
    const r = await ctx.__exec(intent);
    const bulk = calls.find(c=>c.action==='bulkUpdateLotTasks');
    is('writes all 3 finished task statuses', bulk.payload.updates.map(u=>u.task_id), ['T50','T60','T70']);
    is('does NOT write reported_stage/true_stage (stage computed on read)', [bulk.payload.reported_stage, bulk.payload.true_stage], [undefined, undefined]);
    is('does NOT touch the gate (nothing to propagate)', !calls.some(c=>c.action==='updateScheduleLotGate'), true);
    is('push returns success', [r.done, !!r.error], [3, false]);
  }

  console.log('\n── RUN B: "Push entire lot status" CARRIES the source gate -> propagated to target ──');
  {
    const {ctx, calls, intent} = run(true, true);   // target gate released; intent freezes source gate (confirmed=false)
    const r = await ctx.__exec(intent);
    const gateCall = calls.find(c=>c.action==='updateScheduleLotGate');
    is('the gate state IS propagated (updateScheduleLotGate on the target gate row)', !!gateCall, true);
    is('    ...unchecking the TARGET\'s gate-state row (so getScheduleLots will cap it to 5.9)', gateCall && gateCall.payload, {gate_id:'GS11', confirmed:false});
    const bulk = calls.find(c=>c.action==='bulkUpdateLotTasks');
    is('    task statuses still written (all 3)', bulk.payload.updates.map(u=>u.task_id), ['T50','T60','T70']);
    is('    still writes NO stage (single source: getScheduleLots)', bulk.payload.reported_stage, undefined);
    is('    push reports success with gatesApplied=1', [r.done, r.gatesApplied, !!r.error], [3, 1, false]);
    console.log('    → the target now has an unchecked gate; getScheduleLots computes it to 5.9');
    console.log('      (proven in getschedulelots-compute.js, the L12 held case).');
  }

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
