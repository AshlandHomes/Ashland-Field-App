/*
 * test/hold-gates.js — Hold Gates (piece 4) engine proof.
 *
 * TWO proofs, per the build contract:
 *  (1) BACKWARD-COMPAT: the generalized ScheduleEngine.computeStage produces the
 *      IDENTICAL persisted result to the OLD hardcoded-5.9 logic for existing
 *      utility gates, across every state (all off / some on / all on / below
 *      threshold / boundary / first-stage floor / manualCode / no stage).
 *      Persisted fields = reportedCode, held, trueCode, trueLabel, gatesOpen —
 *      these are what a lot stores (reported_stage/true_stage) and what sales
 *      exports read. If these are byte-identical, live lots do not change.
 *  (2) NEW BEHAVIOR: a per-gate hold gate blocks at its configured threshold,
 *      holds while unmet, and snaps to true stage when released — proven for
 *      BOTH release modes (task: all tasks finished; manual: confirmed).
 *
 * Pure Node, no deps. Run: `node test/hold-gates.js` (exit 1 on any failure).
 */
'use strict';
const Engine = require('../schedule-engine.js');

let pass = 0, fail = 0;
function ok(cond, msg){ if(cond){ pass++; } else { fail++; console.log('  ✗ FAIL: ' + msg); } }

// ── OLD computeStage — ported VERBATIM from schedule-engine.js before piece 4
//    (hardcoded 5.9, single `open` boolean). This is the reference behavior.
function oldComputeStage(stageMap, finishedByNum, gateState){
  stageMap = stageMap||[]; finishedByNum = finishedByNum||{}; gateState = gateState||{};
  var achieved = stageMap.filter(function(s){ return !s.is_manual && s.triggers && s.triggers.length && s.triggers.every(function(bt){ return finishedByNum[bt]; }); });
  var trueStage = null;
  achieved.forEach(function(s){ if(!trueStage||s.order>trueStage.order) trueStage=s; });
  if(!trueStage && gateState.manualCode){ trueStage = stageMap.filter(function(s){ return s.code===gateState.manualCode; })[0] || {code:gateState.manualCode,label:'Pre-construction',order:0}; }
  if(!trueStage && stageMap.length){ trueStage = stageMap.reduce(function(a,b){ return b.order<a.order?b:a; }); }
  var gatesOpen = !!gateState.open;
  var held=false, reportedCode, reportedLabel;
  if(trueStage && gatesOpen && parseFloat(trueStage.code)>5.9){ held=true; reportedCode='5.9'; reportedLabel='Utility Hold'; }
  else { reportedCode = trueStage?trueStage.code:'—'; reportedLabel = trueStage?trueStage.label:'Pre-construction'; }
  return { reportedCode:reportedCode, reportedLabel:reportedLabel, held:held, trueCode:trueStage?trueStage.code:null, trueLabel:trueStage?trueStage.label:null, gatesOpen:gatesOpen };
}

// A representative stage map (codes span below and above the 5.9 utility hold).
const STAGES = [
  { code:'1.1', label:'Permit',      order:1, is_manual:false, triggers:[10] },
  { code:'3.0', label:'Foundation',  order:2, is_manual:false, triggers:[20] },
  { code:'6.0', label:'Framing',     order:3, is_manual:false, triggers:[30] },
  { code:'9.0', label:'Final',       order:4, is_manual:false, triggers:[40] },
];
// finishedByNum sets that achieve a given top stage:
const F = {
  none:   {},
  s1_1:   {10:true},
  s3_0:   {10:true,20:true},
  s6_0:   {10:true,20:true,30:true},
  s9_0:   {10:true,20:true,30:true,40:true},
};

// Release computation — EXACTLY what the app adapters do, so the test also
// proves the task-vs-manual release rule, not just the engine cap.
function releaseOf(gate, finishedByNum){
  const bts = (gate.hold_task_bt_nums||[]).map(Number).filter(function(n){ return !isNaN(n); });
  return bts.length ? bts.every(function(bt){ return finishedByNum[bt]; })   // TASK mode
                    : !!gate.confirmed;                                       // MANUAL mode
}
function toEngineGates(gates, finishedByNum){
  return (gates||[]).map(function(g){
    return { threshold:g.hold_stage_code, released:releaseOf(g,finishedByNum), name:g.gate_name, statusMessage:g.status_message };
  });
}

// ═══════════════════════ PROOF 1 — BACKWARD COMPAT ═══════════════════════
// Model REAL utility gates (Power/Water/Gas), all manual, threshold 5.9 — the
// exact live shape. Run OLD (open boolean) vs NEW (gates[]) and compare the
// persisted fields. Also record the reportedLabel delta (display-only, not stored).
console.log('PROOF 1 — backward compat (utility gates: new engine == old engine)');
let labelDeltas = 0;
function utilGates(confirmedFlags){ // e.g. [false,false,false]
  const names=['Power','Water','Gas'];
  return confirmedFlags.map(function(c,i){ return { gate_name:names[i], hold_stage_code:'5.9', hold_task_bt_nums:[], confirmed:c }; });
}
const BC_CASES = [
  { name:'true 6.0, all gates OFF',        f:F.s6_0, conf:[false,false,false] },
  { name:'true 6.0, SOME on',              f:F.s6_0, conf:[true,false,true] },
  { name:'true 6.0, all ON',               f:F.s6_0, conf:[true,true,true] },
  { name:'true 9.0, all OFF',              f:F.s9_0, conf:[false,false,false] },
  { name:'true 9.0, all ON',               f:F.s9_0, conf:[true,true,true] },
  { name:'true 3.0 (below 5.9), all OFF',  f:F.s3_0, conf:[false,false,false] },
  { name:'true 1.1 floor, all OFF',        f:F.s1_1, conf:[false,false,false] },
  { name:'no achieved -> first-stage floor 1.1, all OFF', f:F.none, conf:[false,false,false] },
  { name:'single gate, true 6.0, OFF',     f:F.s6_0, conf:[false] },
  { name:'single gate, true 6.0, ON',      f:F.s6_0, conf:[true] },
  { name:'zero gates, true 9.0',           f:F.s9_0, conf:[] },
];
BC_CASES.forEach(function(c){
  const gates = utilGates(c.conf);
  const open  = gates.some(function(g){ return !g.confirmed; });
  const oldR  = oldComputeStage(STAGES, c.f, { open:open });
  const newR  = Engine.computeStage(STAGES, c.f, { gates: toEngineGates(gates, c.f) });
  ok(oldR.reportedCode === newR.reportedCode, c.name + ' — reportedCode '+JSON.stringify(oldR.reportedCode)+' vs '+JSON.stringify(newR.reportedCode));
  ok(oldR.held        === newR.held,         c.name + ' — held '+oldR.held+' vs '+newR.held);
  ok(oldR.trueCode    === newR.trueCode,     c.name + ' — trueCode '+oldR.trueCode+' vs '+newR.trueCode);
  ok(oldR.trueLabel   === newR.trueLabel,    c.name + ' — trueLabel');
  ok(oldR.gatesOpen   === newR.gatesOpen,    c.name + ' — gatesOpen '+oldR.gatesOpen+' vs '+newR.gatesOpen);
  if(oldR.reportedLabel !== newR.reportedLabel) labelDeltas++;
});
// Manual-code test with no gates (pure pre-construction) — also must match.
[['0.9', F.none],['1.1', F.none]].forEach(function(p){
  const oldR = oldComputeStage(STAGES, p[1], { open:false, manualCode:p[0] });
  const newR = Engine.computeStage(STAGES, p[1], { gates:[], manualCode:p[0] });
  ok(oldR.reportedCode===newR.reportedCode && oldR.held===newR.held && oldR.trueCode===newR.trueCode, 'manualCode '+p[0]+' persisted fields match');
});
// Legacy fallback: NEW engine given the OLD {open} shape (no gates[]) must equal OLD.
[true,false].forEach(function(open){
  const oldR = oldComputeStage(STAGES, F.s6_0, { open:open });
  const newR = Engine.computeStage(STAGES, F.s6_0, { open:open }); // no gates[] -> legacy fallback path
  ok(oldR.reportedCode===newR.reportedCode && oldR.held===newR.held && oldR.reportedLabel===newR.reportedLabel && oldR.gatesOpen===newR.gatesOpen,
     'legacy {open:'+open+'} fallback == old (incl. label)');
});

// ═══════════════════════ PROOF 2 — NEW BEHAVIOR ═══════════════════════
console.log('PROOF 2 — new per-gate hold gates (block at threshold, release, snap)');

// TASK MODE: one gate @6.0, released by tasks [30 already drives stage; use extra 31,32].
const TASK_STAGES = STAGES.concat([]); // same map
function taskGate(){ return { gate_name:'Closing Hold', hold_stage_code:'6.0', hold_task_bt_nums:[31,32], status_message:'Do not schedule closing' }; }
// advances normally BELOW threshold:
let r = Engine.computeStage(STAGES, {10:true,20:true}, { gates: toEngineGates([taskGate()], {10:true,20:true}) }); // true 3.0
ok(r.reportedCode==='3.0' && !r.held, 'task-gate: below threshold advances normally (3.0, not held)');
// at threshold exactly (6.0) — boundary, not held:
r = Engine.computeStage(STAGES, {10:true,20:true,30:true}, { gates: toEngineGates([taskGate()], {10:true,20:true,30:true}) }); // true 6.0
ok(r.reportedCode==='6.0' && !r.held, 'task-gate: at threshold 6.0 exactly is NOT held (boundary)');
// past threshold, gate tasks NOT done -> HELD at 6.0:
r = Engine.computeStage(STAGES, {10:true,20:true,30:true,40:true}, { gates: toEngineGates([taskGate()], {10:true,20:true,30:true,40:true}) }); // true 9.0, tasks 31/32 not done
ok(r.held && r.reportedCode==='6.0' && r.trueCode==='9.0', 'task-gate: past threshold holds at 6.0 (true 9.0)');
ok(r.blockingMessage==='Do not schedule closing', 'task-gate: surfaces status message when held');
// gate tasks completed -> released -> SNAP to true 9.0:
r = Engine.computeStage(STAGES, {10:true,20:true,30:true,40:true,31:true,32:true}, { gates: toEngineGates([taskGate()], {10:true,20:true,30:true,40:true,31:true,32:true}) });
ok(!r.held && r.reportedCode==='9.0', 'task-gate: all tasks done releases -> snaps to true 9.0');
// partial task completion does NOT release:
r = Engine.computeStage(STAGES, {10:true,20:true,30:true,40:true,31:true}, { gates: toEngineGates([taskGate()], {10:true,20:true,30:true,40:true,31:true}) });
ok(r.held && r.reportedCode==='6.0', 'task-gate: partial completion (31 only) stays held');

// MANUAL MODE: one gate @6.0, no tasks, released by confirm.
function manGate(conf){ return { gate_name:'Inspection Hold', hold_stage_code:'6.0', hold_task_bt_nums:[], confirmed:conf }; }
r = Engine.computeStage(STAGES, F.s9_0, { gates: toEngineGates([manGate(false)], F.s9_0) });
ok(r.held && r.reportedCode==='6.0', 'manual-gate: unconfirmed holds at 6.0 (true 9.0)');
r = Engine.computeStage(STAGES, F.s9_0, { gates: toEngineGates([manGate(true)], F.s9_0) });
ok(!r.held && r.reportedCode==='9.0', 'manual-gate: confirmed releases -> snaps to true 9.0');

// MULTIPLE independent thresholds: @6.0 and @9.0, true 9.0.
function twoGates(rel6, rel9){ return [
  { gate_name:'Hold A', hold_stage_code:'6.0', hold_task_bt_nums:[], confirmed:rel6 },
  { gate_name:'Hold B', hold_stage_code:'9.0', hold_task_bt_nums:[], confirmed:rel9 },
]; }
// Use true 9.0 tasks + a stage beyond 9.0? Our top stage is 9.0; 9.0 gate needs true>9.0 to engage.
// Add a 9.5 stage for this sub-case so both can engage.
const STAGES2 = STAGES.concat([{ code:'9.5', label:'Closeout', order:5, is_manual:false, triggers:[50] }]);
const F950 = {10:true,20:true,30:true,40:true,50:true}; // true 9.5
r = Engine.computeStage(STAGES2, F950, { gates: toEngineGates(twoGates(false,false), F950) });
ok(r.held && r.reportedCode==='6.0', 'multi: both open, true 9.5 -> held at LOWEST (6.0)');
r = Engine.computeStage(STAGES2, F950, { gates: toEngineGates(twoGates(true,false), F950) });
ok(r.held && r.reportedCode==='9.0', 'multi: release 6.0 -> now held at 9.0');
r = Engine.computeStage(STAGES2, F950, { gates: toEngineGates(twoGates(true,true), F950) });
ok(!r.held && r.reportedCode==='9.5', 'multi: release both -> snaps to true 9.5');

// Zero gates -> never held.
r = Engine.computeStage(STAGES2, F950, { gates: [] });
ok(!r.held && r.reportedCode==='9.5', 'zero gates: plain true stage, never held');

// ── summary ──
console.log('');
console.log('reportedLabel deltas in backward-compat cases (display-only, NOT persisted): ' + labelDeltas);
console.log('  (old held caption was hardcoded "Utility Hold"; new shows the blocking gate name — reported_stage/true_stage unchanged)');
console.log('');
console.log((fail===0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' assertions passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
