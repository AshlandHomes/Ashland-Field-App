'use strict';
// STEP 1 proof: getScheduleLots now COMPUTES reported_stage/true_stage/no_stages/hold
// surfacing from each lot's live task+gate state via the shared engine, ignoring the
// stored column. Runs the REAL handler body (sliced from supabase.js) against a mocked
// supabaseRequest + real ScheduleEngine.
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const src = fs.readFileSync(__dirname + '/../netlify/functions/supabase.js','utf8');
const START = "case 'getScheduleLots': {";
let body = src.slice(src.indexOf(START) + START.length, src.indexOf("case 'deleteScheduleLot':"));
body = body.replace(/}\s*$/, '');   // drop the case's closing brace

// ── template TPL: stages 1.1(floor)/6.0/7.0/8.0, one MANUAL utility gate at 5.9 ──
const TPL_STAGEMAP = [
  {id:'s1', stage_code:'1.1', stage_label:'Start', is_manual:false, stage_order:11},
  {id:'s6', stage_code:'6.0', stage_label:'Six',   is_manual:false, stage_order:60},
  {id:'s7', stage_code:'7.0', stage_label:'Seven', is_manual:false, stage_order:70},
  {id:'s8', stage_code:'8.0', stage_label:'Eight', is_manual:false, stage_order:80},
];
const TPL_TASKS = [{id:'t10',bt_num:10},{id:'t60',bt_num:60},{id:'t70',bt_num:70},{id:'t80',bt_num:80}];
const TPL_JOINS = [{stage_map_id:'s1',task_id:'t10'},{stage_map_id:'s6',task_id:'t60'},{stage_map_id:'s7',task_id:'t70'},{stage_map_id:'s8',task_id:'t80'}];
const TPL_GATES = [{id:'G1', name:'Utility Hold', hold_stage_code:'5.9', status_message:'Waiting on utility', hold_task_bt_nums:[]}];

// finished-task rows per lot (status finished only matters)
const LOT_TASKS = {
  L10:[10,60,70,80], L11:[], L12:[10,60,70], L13:[10],
};
const fin = (lot)=> (LOT_TASKS[lot]||[]).map(bt=>({lot_id:lot,bt_num:bt,status:'finished'}));
// manual gate confirmations per lot (source_gate_id G1)
const LOT_GATE = { L10:true, L11:true, L12:false /*held*/, L13:true };

function mock(failTasks){
  return async (method, path)=>{
    if (path.startsWith('sched_lots?select=*')) return { data: [
      {id:'L10', template_id:'TPL', manual_stage:null, reported_stage:'6.0', true_stage:'6.0'}, // STORED is stale 6.0
      {id:'L11', template_id:'TPL', manual_stage:null, reported_stage:null,  true_stage:null},
      {id:'L12', template_id:'TPL', manual_stage:null, reported_stage:'7.0', true_stage:'7.0'},
      {id:'L13', template_id:'TPL2',manual_stage:null, reported_stage:null,  true_stage:null},  // TPL2 has NO stages
      {id:'L99', template_id:null,  manual_stage:null, reported_stage:null,  true_stage:null},  // no template -> untouched
    ]};
    if (path.includes('sched_template_stage_map?template_id=eq.TPL2')) return { data: [] };      // opted out
    if (path.includes('sched_template_stage_map?template_id=eq.TPL'))  return { data: TPL_STAGEMAP };
    if (path.includes('sched_template_tasks?template_id=eq.TPL2')) return { data: [] };
    if (path.includes('sched_template_tasks?template_id=eq.TPL'))  return { data: TPL_TASKS };
    if (path.includes('sched_stage_map_tasks')) return { data: TPL_JOINS };
    if (path.includes('sched_template_gates?template_id=eq.TPL2')) return { data: [] };
    if (path.includes('sched_template_gates?template_id=eq.TPL'))  return { data: TPL_GATES };
    if (path.startsWith('sched_lot_tasks?lot_id=in.')) {
      if (failTasks) return { error: 'simulated task-fetch failure' };
      const rows=[]; ['L10','L11','L12','L13'].forEach(l=>rows.push(...fin(l))); return { data: rows };
    }
    if (path.startsWith('sched_lot_gate_state?lot_id=in.')) {
      const rows=[]; Object.keys(LOT_GATE).forEach(l=>rows.push({lot_id:l,source_gate_id:'G1',confirmed:LOT_GATE[l]})); return { data: rows };
    }
    return { data: [] };
  };
}

async function runLots(failTasks){
  const ctx = { supabaseRequest: mock(failTasks), ScheduleEngine: SE, console, Promise };
  vm.createContext(ctx);
  vm.runInContext('async function run(){' + body + '}\nthis.__run = run;', ctx);
  const res = await ctx.__run();
  return JSON.parse(res.body);
}

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

(async()=>{
  const lots = await runLots(false);
  const L = id => lots.find(l=>l.id===id);

  is('L10 computed to 8.0 — IGNORES the stale stored 6.0 (the exact drift bug)', L('L10').reported_stage, '8.0');
  is('L10 true_stage computed 8.0', L('L10').true_stage, '8.0');
  is('L11 (no tasks finished) floors to first stage 1.1', L('L11').reported_stage, '1.1');
  is('L12 HELD at 5.9 by the unconfirmed manual gate (true still 7.0)', [L('L12').reported_stage, L('L12').true_stage], ['5.9','7.0']);
  is('L12 hold surfacing attached (gate name)', L('L12').hold_gate_name, 'Utility Hold');
  is('L13 on a stageless template -> no_stages, stage null', [L('L13').no_stages, L('L13').reported_stage], [true, null]);
  is('L99 (no template) left untouched', [L('L99').reported_stage, L('L99').no_stages], [null, undefined]);

  // FALLBACK (option b): if the live task fetch fails, the stage is BLANKED — never the
  // stored value (which no longer updates and would drift/lie). Blank-on-error is honest.
  const lots2 = await runLots(true);
  const L2 = id => lots2.find(l=>l.id===id);
  is('fetch failure -> L10 stage BLANKED, NOT the drifting stored 6.0 (fallback b)', L2('L10').reported_stage, null);
  is('fetch failure -> L10 flagged stage_unavailable (readers show "—", not N/A)', L2('L10').stage_unavailable, true);
  is('fetch failure -> L12 stage BLANKED (not stored 7.0)', L2('L12').reported_stage, null);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
