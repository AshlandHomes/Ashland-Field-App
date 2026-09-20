'use strict';
// Back-out from a lot refreshes THAT lot's list badge from the in-memory state, so the
// builder sees their own edits without a manual pull. Runs the REAL refreshCurLotInList
// + computeStage (sliced from the field app) against the gate repro: an unchecked manual
// gate holds the lot at 5.9, and the (stale 7.0) list row must update to 5.9 on back-out.
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const sl = (a,b)=>html.slice(html.indexOf(a), html.indexOf(b));
const CODE = sl('function computeStage(){','// ── STAGE LEGEND') + '\n' +
             sl('function refreshCurLotInList(){','function backToLots(');

function run(ctxVars){
  const ctx = Object.assign({ ScheduleEngine: SE, console }, ctxVars);
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.__refresh = refreshCurLotInList;', ctx);
  return ctx;
}

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

// gate repro: tasks 60 & 70 finished (true 7.0), manual utility gate UNCHECKED -> held 5.9
const stageMap = [ {code:'6.0',label:'Six',is_manual:false,order:60,triggers:[60]},
                   {code:'7.0',label:'Seven',is_manual:false,order:70,triggers:[70]} ];
const act = { 60:{finished:true}, 70:{finished:true} };
const gateUnchecked = [{ hold_stage_code:'5.9', hold_task_bt_nums:[], confirmed:false, gate_name:'Utility Hold' }];
const gateChecked   = [{ hold_stage_code:'5.9', hold_task_bt_nums:[], confirmed:true,  gate_name:'Utility Hold' }];

// 1) the exact repro: list row stale at 7.0 -> back-out computes 5.9 and patches it.
{
  const myLots = [{ id:'L11', reported_stage:'7.0', true_stage:'7.0' }];
  const ctx = run({ curLot:{id:'L11'}, myLots, act, lotGates:gateUnchecked, stageMap, curManual:null });
  ctx.__refresh();
  is('back-out patches the list row to 5.9 (held) — no manual pull needed', myLots[0].reported_stage, '5.9');
  is('true_stage patched to 7.0 (so the list shows "held at 5.9")', myLots[0].true_stage, '7.0');
}

// 2) reverse: gate re-checked -> list row updates back up to 7.0.
{
  const myLots = [{ id:'L11', reported_stage:'5.9', true_stage:'7.0' }];
  const ctx = run({ curLot:{id:'L11'}, myLots, act, lotGates:gateChecked, stageMap, curManual:null });
  ctx.__refresh();
  is('re-checking the gate updates the list row back to 7.0', myLots[0].reported_stage, '7.0');
}

// 3) safety: no matching list row / no curLot -> no throw, no change.
{
  const myLots = [{ id:'OTHER', reported_stage:'3.3', true_stage:'3.3' }];
  const ctx = run({ curLot:{id:'L11'}, myLots, act, lotGates:gateUnchecked, stageMap, curManual:null });
  ctx.__refresh();
  is('lot not in the list -> untouched (no throw)', myLots[0].reported_stage, '3.3');
  const ctx2 = run({ curLot:null, myLots:[], act:{}, lotGates:[], stageMap:[], curManual:null });
  ctx2.__refresh();
  is('no open lot -> no-op (no throw)', true, true);
}

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
