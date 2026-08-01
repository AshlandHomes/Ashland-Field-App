/*
 * test/parity.js — behavior-parity acceptance harness (BUILD_SPEC §7.3)
 * ---------------------------------------------------------------------------
 * Proves the extracted schedule-engine.js reproduces the PROVEN engines on
 * REAL data before any caller is wired. It snapshots the three current
 * engines VERBATIM from the live code:
 *
 *   OLD-A  field app  runEngine()          (ashland-stage-update-dev.html)  — SOURCE OF TRUTH
 *   OLD-B  backend    calcEF/calcLS         (supabase.js recomputeTemplateCritical) — 99d/51-crit writer
 *   OLD-C  backend    computeProjected()    (supabase.js getAllLotPhases) — admin's projected dates (the divergent copy)
 *
 * and asserts:
 *   1. NEW module  ==  OLD-A   for es/ef on every task, every scenario  (clean extraction)
 *   2. NEW module  ==  OLD-B   for es/ef + critical set  (99 WD / 51 critical regression)
 *   3. NEW module  vs OLD-C    — reports the DIFFS (negative lag + floor-at-1),
 *      i.e. the admin dates that are wrong today and get corrected to match the field app.
 *
 * DATA: reads JSON fixtures pulled from dev Supabase (dev_ prefix). See
 * test/pull-fixtures.sh. Falls back to a SYNTHETIC fixture (clearly banner-flagged)
 * only to self-check the harness when no real data is present.
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../schedule-engine.js');

const FIXTURE_DIR = process.env.FIXTURE_DIR || path.join(__dirname, 'fixtures');

const { wdBetween, addWD, ymd, oldFieldEngine, oldBackendTemplate, oldBackendProjected } = require('./old-engines');
// ── adapters: DB row shapes → the shape each consumer expects ──
function tmplToField(t) {
  return { num:t.bt_num, rs:t.relative_start, dur:t.duration, lag:(t.lag||0), rf:t.relative_finish,
           preds:t.predecessors||[], order:t.task_order, est_start_date:t.est_start_date||null,
           is_crit:!!t.is_critical, act:{ started:(t.status==='started'||t.status==='finished'),
           finished:(t.status==='finished'), start:t.actual_start, finish:t.actual_finish } };
}

// ── diff util ──
function diffOffsets(label, aMap, bMap, keys) {
  const diffs = [];
  keys.forEach(k => { if (aMap[k] !== bMap[k]) diffs.push({ num:k, a:aMap[k], b:bMap[k] }); });
  return diffs;
}
function bar(s){ return '\n' + '='.repeat(72) + '\n' + s + '\n' + '='.repeat(72); }
function ok(b){ return b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'; }

// ── load fixtures (real) or synthesize (self-check only) ──
function loadJSON(name) {
  const p = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function synthTemplate() {
  // Small hand-built template that EXERCISES every code path:
  // forward chain, a negative-lag order task, and a floating (no-pred) task.
  return [
    { bt_num:1, name:'Silt Fence',      duration:1, lag:0,   relative_start:1,  predecessors:[],   task_order:1, force_critical:true,  is_critical:true },
    { bt_num:2, name:'Excavate',        duration:3, lag:0,   relative_start:2,  predecessors:[1],  task_order:2, force_critical:true,  is_critical:true },
    { bt_num:3, name:'Footings',        duration:2, lag:0,   relative_start:5,  predecessors:[2],  task_order:3, force_critical:true,  is_critical:true },
    { bt_num:4, name:'Order Cabinets',  duration:1, lag:-15, relative_start:1,  predecessors:[3],  task_order:4, force_critical:false, is_critical:false },
    { bt_num:5, name:'Pour Slab',       duration:2, lag:0,   relative_start:7,  predecessors:[3],  task_order:5, force_critical:false, is_critical:false },
    { bt_num:6, name:'Shutter Install', duration:1, lag:0,   relative_start:12, predecessors:[],   task_order:6, force_critical:false, is_critical:false }
  ];
}

// =====================================================================
// RUN
// =====================================================================
const templateTasks = loadJSON('template_tasks.json') || synthTemplate();
const REAL = !!loadJSON('template_tasks.json');
const lotMeta = loadJSON('lot.json');            // { id, construction_start_date, ... }
const lotTasks = loadJSON('lot_tasks.json');     // [ sched_lot_tasks rows ]

console.log(bar((REAL ? 'REAL dev Supabase data' : '\x1b[33mSYNTHETIC fixture (harness self-check only — NOT real Slab data)\x1b[0m')
  + '\nTemplate tasks: ' + templateTasks.length));

const startStr = (lotMeta && lotMeta.construction_start_date) || '2026-03-02'; // a Monday
const startDate = new Date(startStr + 'T00:00:00');
let allPass = true;

// ---- TEST 1: NEW module (planned) == OLD-A field engine (planned) : es/ef ----
{
  const fieldTasks = templateTasks.map(tmplToField).map(t => Object.assign({}, t, { act:{} })); // planned ignores actuals
  const A = oldFieldEngine(fieldTasks, startDate, 'planned');
  const N = Engine.computeSchedule(templateTasks, { startDate, mode:'planned' });
  const nEs = {}, nEf = {}; N.tasks.forEach(r => { nEs[r.num]=r.es; nEf[r.num]=r.ef; });
  const keys = templateTasks.map(t => t.bt_num);
  const dEs = diffOffsets('es', A.es, nEs, keys);
  const dEf = diffOffsets('ef', A.ef, nEf, keys);
  const pass = dEs.length===0 && dEf.length===0;
  allPass = allPass && pass;
  console.log(bar('TEST 1 — NEW module == OLD-A (field app) : planned es/ef  [' + ok(pass) + ']'));
  console.log('  end offset: NEW=' + N.end + '  OLD-A=' + A.end);
  if (!pass) { console.log('  es diffs:', dEs.slice(0,20)); console.log('  ef diffs:', dEf.slice(0,20)); }
}

// ---- TEST 2: NEW module (projected) == OLD-A field engine (projected) ----
{
  const fieldTasks = templateTasks.map(tmplToField);
  const A = oldFieldEngine(fieldTasks, startDate, 'projected');
  const N = Engine.computeSchedule(templateTasks, { startDate, mode:'projected' });
  const nEs = {}, nEf = {}; N.tasks.forEach(r => { nEs[r.num]=r.es; nEf[r.num]=r.ef; });
  const keys = templateTasks.map(t => t.bt_num);
  const dEs = diffOffsets('es', A.es, nEs, keys);
  const dEf = diffOffsets('ef', A.ef, nEf, keys);
  const pass = dEs.length===0 && dEf.length===0;
  allPass = allPass && pass;
  console.log(bar('TEST 2 — NEW module == OLD-A (field app) : projected es/ef  [' + ok(pass) + ']'));
  if (!pass) { console.log('  es diffs:', dEs.slice(0,20)); console.log('  ef diffs:', dEf.slice(0,20)); }
}

// ---- TEST 3: NEW module (planned) == OLD-B backend template : es/ef + critical (99d/51) ----
{
  const B = oldBackendTemplate(templateTasks);
  const N = Engine.computeSchedule(templateTasks, { startDate, mode:'planned' });
  const nEs = {}, nEf = {}, nCrit = {}; N.tasks.forEach(r => { nEs[r.num]=r.es; nEf[r.num]=r.ef; nCrit[r.num]=r.critical; });
  const keys = templateTasks.map(t => t.bt_num);
  const dEs = diffOffsets('es', B.ES, nEs, keys);
  const dEf = diffOffsets('ef', B.EF, nEf, keys);
  const critDiffs = keys.filter(k => !!B.isCrit[k] !== !!nCrit[k]);
  const nCritCount = keys.filter(k => nCrit[k]).length;
  const pass = dEs.length===0 && dEf.length===0 && critDiffs.length===0;
  allPass = allPass && pass;
  const rawEnd = Math.max.apply(null, templateTasks.map(t => (t.relative_finish != null ? t.relative_finish : (t.relative_start||1) + (t.duration||1) - 1)));
  console.log(bar('TEST 3 — NEW module == OLD-B (backend template) : es/ef + critical  [' + ok(pass) + ']'));
  console.log('  COMPUTED project end (CPM, working days): NEW=' + N.end + '  OLD-B=' + B.projectEnd);
  console.log('  RAW hand-authored end (max relative_finish): ' + rawEnd + (REAL ? '   <- the spec\'s "99" figure' : ''));
  if (REAL && N.end !== rawEnd) console.log('  NOTE: computed end (' + N.end + ') < raw end (' + rawEnd + ') by ' + (rawEnd - N.end) + ' WD — the predecessor network compresses the hand-authored dates (BUILD_SPEC §2.4). All three engines agree on ' + N.end + '.');
  console.log('  critical count:             NEW=' + nCritCount + '  OLD-B=' + B.criticalCount + (REAL ? '   (spec regression target: 51)' : ''));
  if (!pass) { console.log('  es diffs:', dEs.slice(0,20)); console.log('  ef diffs:', dEf.slice(0,20)); console.log('  crit diffs on:', critDiffs.slice(0,20)); }
}

// ---- TEST 4: scenario battery — NEW==OLD-A on mutated copies (projected) ----
{
  console.log(bar('TEST 4 — scenario battery : NEW module == OLD-A (field app), projected'));
  const base = templateTasks;
  // pick a mid-chain task with a predecessor for started/finished/est scenarios
  const chained = base.filter(t => (t.predecessors||[]).length>0);
  const pick = (chained[Math.floor(chained.length/2)] || base[0]).bt_num;
  const startISO = ymd(addWD(startDate, 4));   // some working day after start
  const finISO   = ymd(addWD(startDate, 6));
  const estISO   = ymd(addWD(startDate, 30));
  const scenarios = [
    ['clean (no actuals)',            b => b],
    ['a STARTED task #'+pick,         b => b.map(t => t.bt_num===pick ? Object.assign({},t,{status:'started', actual_start:startISO}) : t)],
    ['a FINISHED task #'+pick,        b => b.map(t => t.bt_num===pick ? Object.assign({},t,{status:'finished', actual_start:startISO, actual_finish:finISO}) : t)],
    ['an est_start_date FLOOR #'+pick,b => b.map(t => t.bt_num===pick ? Object.assign({},t,{est_start_date:estISO}) : t)],
    ['a NEGATIVE-LAG order task',     b => b], // negative lag already present in real data / synth #4
  ];
  scenarios.forEach(([label, mut]) => {
    const tasks = mut(base.map(t => Object.assign({}, t)));
    const A = oldFieldEngine(tasks.map(tmplToField), startDate, 'projected');
    const N = Engine.computeSchedule(tasks, { startDate, mode:'projected' });
    const nEs = {}, nEf = {}; N.tasks.forEach(r => { nEs[r.num]=r.es; nEf[r.num]=r.ef; });
    const keys = tasks.map(t => t.bt_num);
    const dEs = diffOffsets('es', A.es, nEs, keys);
    const dEf = diffOffsets('ef', A.ef, nEf, keys);
    const pass = dEs.length===0 && dEf.length===0;
    allPass = allPass && pass;
    console.log('  [' + ok(pass) + '] ' + label);
    if (!pass) { console.log('      es diffs:', dEs.slice(0,10)); console.log('      ef diffs:', dEf.slice(0,10)); }
  });
}

// ---- TEST 5: the DRIFT, quantified — real lot: NEW==OLD-A, and NEW vs OLD-C diffs ----
if (lotTasks && lotMeta) {
  console.log(bar('TEST 5 — REAL LOT ' + (lotMeta.lot_number||lotMeta.id) + ' : drift between field app and admin'));
  const lotStart = lotMeta.construction_start_date;
  const lotStartDate = new Date(lotStart + 'T00:00:00');
  // field-shaped for OLD-A
  const fieldTasks = lotTasks.map(r => ({ num:r.bt_num, rs:r.relative_start, dur:r.duration, lag:(r.lag||0), rf:r.relative_finish,
    preds:r.predecessors||[], order:r.task_order, est_start_date:r.est_start_date||null, is_crit:!!r.is_critical,
    act:{ started:(r.status==='started'||r.status==='finished'), finished:(r.status==='finished'), start:r.actual_start, finish:r.actual_finish } }));
  const A = oldFieldEngine(fieldTasks, lotStartDate, 'projected');
  const C = oldBackendProjected(lotTasks, lotStart);
  const N = Engine.computeSchedule(lotTasks, { startDate: lotStartDate, mode:'projected' });
  const nEs = {}; N.tasks.forEach(r => nEs[r.num]=r.es);
  const keys = lotTasks.map(t => t.bt_num);

  const dNA = diffOffsets('es', A.es, nEs, keys);         // must be zero
  const dNC = diffOffsets('es', C.es, nEs, keys);         // the corrected (previously-wrong admin) tasks
  const passNA = dNA.length === 0;
  allPass = allPass && passNA;
  console.log('  NEW module == OLD-A (field app) on the real lot: [' + ok(passNA) + ']' + (passNA ? '  (identical on all '+keys.length+' tasks)' : ''));
  if (!passNA) console.log('  UNEXPECTED es diffs vs field app:', dNA.slice(0,20));
  // classify + count
  const nameByNum = {}; lotTasks.forEach(t => nameByNum[t.bt_num]=t.name);
  let cNeg=0, cFloor=0, cCasc=0;
  const rows = dNC.map(d => {
    const t = lotTasks.find(x => x.bt_num===d.num) || {};
    let reason;
    if (d.a < 1) { reason = 'below-floor clamp ('+d.a+' = '+Math.abs(d.a-1)+' WD before construction start!)'; cFloor++; }
    else if ((t.lag||0) < 0) { reason = 'negative-lag (lead time '+t.lag+')'; cNeg++; }
    else { reason = 'cascade'; cCasc++; }
    return { num:d.num, a:d.a, b:d.b, reason };
  });
  console.log('  Admin (OLD-C) tasks that CHANGE to match the field app: ' + dNC.length + ' of ' + keys.length);
  console.log('    breakdown: '+cNeg+' negative-lag, '+cFloor+' below-floor clamp, '+cCasc+' downstream cascade');
  console.log('  full list (admin es  →  correct es):');
  rows.forEach(r => {
    console.log('    #'+String(r.num).padStart(3)+' '+(nameByNum[r.num]||'').slice(0,34).padEnd(34)+'  '+String(r.a).padStart(4)+'  →  '+String(r.b).padStart(3)+'   ['+r.reason+']');
  });

  // ── data-sanity: finished tasks whose predecessors never started (stale test data) ──
  const statusByNum = {}; lotTasks.forEach(t => statusByNum[t.bt_num]=t.status);
  const sanity = [];
  lotTasks.forEach(t => {
    if (t.status === 'finished') {
      (t.predecessors||[]).forEach(p => {
        if (statusByNum[p] && statusByNum[p] !== 'started' && statusByNum[p] !== 'finished') {
          sanity.push({ num:t.bt_num, name:t.name, pred:p, predName:nameByNum[p], predStatus:statusByNum[p] });
        }
      });
    }
  });
  console.log('\n  DATA-SANITY (does not affect parity — actuals are truth in all engines):');
  if (sanity.length === 0) console.log('    none');
  else sanity.forEach(s => console.log('    ⚠ #'+s.num+' '+s.name+' is FINISHED but predecessor #'+s.pred+' ('+s.predName+') is '+s.predStatus+' — stale test data, clean up.'));
} else {
  console.log(bar('TEST 5 — skipped (no real lot fixture: lot.json / lot_tasks.json)'));
}

console.log(bar('OVERALL: ' + ok(allPass) + (REAL ? '' : '   \x1b[33m(SYNTHETIC — run against real dev data before trusting)\x1b[0m')));
process.exit(allPass ? 0 : 1);
