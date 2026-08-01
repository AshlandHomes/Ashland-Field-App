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

// ── shared working-day helpers, identical to both old engines ──
function wdBetween(a, b) {
  let d1 = new Date(a), d2 = new Date(b); d1.setHours(0,0,0,0); d2.setHours(0,0,0,0);
  if (d1.getTime() === d2.getTime()) return 0;
  const sign = d2 > d1 ? 1 : -1; let cur = new Date(d1), c = 0;
  while (cur.getTime() !== d2.getTime()) { cur.setDate(cur.getDate()+sign); const w = cur.getDay(); if (w!==0&&w!==6) c+=sign; }
  return c;
}
function addWD(start, off){ let d=new Date(start); d.setHours(0,0,0,0); let c=1; while(c<off){d.setDate(d.getDate()+1);const w=d.getDay();if(w!==0&&w!==6)c++;} return d; }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

/* =====================================================================
 * OLD-A — field app runEngine(), ported verbatim from
 * ashland-stage-update-dev.html L495-581. Operates on field-shaped tasks:
 *   { num, rs, dur, lag, rf, preds:[], est_start_date, order, act:{started,finished,start,finish} }
 * Returns { es:{num}, ef:{num}, end, crit:{num} }.
 * ===================================================================== */
function oldFieldEngine(TASKS, startDate, mode) {
  TASKS = TASKS.map(t => Object.assign({}, t)); // isolate the _es/_ef scratch fields
  const bn = {}; TASKS.forEach(t => bn[t.num] = t);
  const act = {}; TASKS.forEach(t => act[t.num] = t.act || {});
  const actOffset = (iso) => { if (!startDate || !iso) return null; return wdBetween(startDate, new Date(iso+'T00:00:00'))+1; };
  const es = {}, ef = {}, crit = {};
  const hasPreds = TASKS.some(t => t.preds && t.preds.length > 0);
  if (hasPreds) {
    const memo = {};
    function efc(n, stk) {
      if (memo[n] !== undefined) return memo[n];
      const t = bn[n]; if (stk.includes(n)) return t.rf || 1;
      let pd = null, backDriver = null;
      (t.preds || []).forEach(p => { if (bn[p]) {
        efc(p, [...stk, n]);
        const pStart = bn[p]['_'+mode+'_es'], pFin = bn[p]['_'+mode+'_ef'];
        if (t.lag < 0) { const cand = pStart + t.lag; backDriver = (backDriver===null)?cand:Math.min(backDriver,cand); }
        else { const cand = pFin + 1 + t.lag; pd = (pd===null)?cand:Math.max(pd,cand); }
      }});
      let e_s; const a = act[n] || {};
      const aStartOff = (mode==='projected'&&a.started&&a.start)?actOffset(a.start):null;
      if (aStartOff !== null) { e_s = aStartOff; }
      else if (t.lag < 0 && backDriver !== null) { e_s = backDriver; }
      else { e_s = pd!==null?pd:(t.rs||1); if (mode==='projected'&&!a.started&&t.est_start_date){const eo=actOffset(t.est_start_date); if(eo!==null)e_s=Math.max(e_s,eo);} }
      if (e_s < 1) e_s = 1;
      let e; const aFinOff = (mode==='projected'&&a.finished&&a.finish)?actOffset(a.finish):null;
      if (aFinOff !== null) { e = aFinOff; } else { e = e_s + t.dur - 1; }
      memo[n] = e; t['_'+mode+'_es'] = e_s; t['_'+mode+'_ef'] = e; es[n]=e_s; ef[n]=e; return e;
    }
    TASKS.forEach(t => efc(t.num, []));
    const end = Math.max(...TASKS.map(t => t['_'+mode+'_ef']));
    if (mode === 'planned') {
      const succ = {}; TASKS.forEach(t => succ[t.num] = []);
      TASKS.forEach(t => (t.preds||[]).forEach(p => { if (succ[p]) succ[p].push(t.num); }));
      const lf = {};
      function latef(n, stk){ if(lf[n]!==undefined)return lf[n]; if(stk.includes(n))return end; const ss=succ[n]; let v=ss.length===0?end:Math.min(...ss.map(s=>latef(s,[...stk,n])-bn[s].dur+1-1-bn[s].lag)); lf[n]=v; return v; }
      TASKS.forEach(t => { const _lf=latef(t.num,[]); const _ls=_lf-t.dur+1; const _tf=_ls-t['_planned_es']; crit[t.num]=(_tf<=0); });
    }
    return { es, ef, end, crit };
  }
  // no-preds sequential slip branch (L555-580)
  const sorted = [...TASKS].sort((a,b)=>(a.rs||1)-(b.rs||1)||(a.order||0)-(b.order||0));
  let maxSlip = 0;
  if (mode === 'projected') {
    sorted.forEach(t => {
      const a = act[t.num]||{};
      const aStartOff=(a.started&&a.start)?actOffset(a.start):null;
      const aFinOff=(a.finished&&a.finish)?actOffset(a.finish):null;
      const estOff=(!a.started&&t.est_start_date)?actOffset(t.est_start_date):null;
      let slip=0;
      if(aFinOff!==null){slip=aFinOff-((t.rs||1)+t.dur-1);}
      else if(aStartOff!==null){slip=aStartOff-(t.rs||1);}
      else if(estOff!==null){slip=Math.max(0,estOff-(t.rs||1));}
      maxSlip=Math.max(maxSlip,slip);
      es[t.num]=(t.rs||1)+maxSlip; ef[t.num]=aFinOff!==null?aFinOff:es[t.num]+t.dur-1;
    });
  } else {
    sorted.forEach(t => { es[t.num]=t.rs||1; ef[t.num]=(t.rs||1)+t.dur-1; });
  }
  const end = Math.max(...TASKS.map(t => ef[t.num]));
  if (mode === 'planned') { TASKS.forEach(t=>{ const _ls=end-t.dur+1; const _tf=_ls-(es[t.num]||t.rs||1); crit[t.num]=(_tf<=0)||!!t.is_crit; }); }
  return { es, ef, end, crit };
}

/* =====================================================================
 * OLD-B — backend calcEF/calcLS, ported verbatim from supabase.js L416-501.
 * Tasks: { bt_num, duration, lag, relative_start, predecessors, force_critical }.
 * Returns { ES, EF, projectEnd, isCrit:{bt_num}, criticalCount }.
 * ===================================================================== */
function oldBackendTemplate(tasks) {
  const byNum = {}; tasks.forEach(t => { byNum[t.bt_num] = t; });
  const dur = t => (t.duration != null ? t.duration : 1);
  const ES = {}, EF = {};
  function calcEF(num, stack) {
    if (EF[num] !== undefined) return EF[num];
    const t = byNum[num]; if (!t) return 0;
    if (stack.indexOf(num) >= 0) { ES[num] = 1; EF[num] = dur(t); return EF[num]; }
    const preds = Array.isArray(t.predecessors) ? t.predecessors : [];
    const lag = (t.lag || 0); let fwd = null, back = null;
    preds.forEach(p => { if (byNum[p]) {
      calcEF(p, stack.concat([num]));
      const pStart = ES[p], pFin = EF[p];
      if (lag < 0) { const cand = pStart + lag; if (back===null||cand<back) back=cand; }
      else { const cand = pFin + 1 + lag; if (fwd===null||cand>fwd) fwd=cand; }
    }});
    let start;
    if (lag < 0 && back !== null) { start = back; }
    else { start = fwd; if (start === null) start = (t.relative_start != null ? t.relative_start : 1); }
    if (start < 1) start = 1;
    ES[num] = start; EF[num] = start + dur(t) - 1; return EF[num];
  }
  tasks.forEach(t => calcEF(t.bt_num, []));
  const projectEnd = Math.max.apply(null, tasks.map(t => EF[t.bt_num] || 0));
  const succ = {};
  tasks.forEach(t => { (Array.isArray(t.predecessors)?t.predecessors:[]).forEach(p => { if (byNum[p]) (succ[p]=succ[p]||[]).push(t.bt_num); }); });
  const LF = {}, LS = {};
  function calcLS(num, stack) {
    if (LS[num] !== undefined) return LS[num];
    const t = byNum[num]; if (!t) return projectEnd;
    if (stack.indexOf(num) >= 0) { LF[num] = projectEnd; LS[num] = projectEnd - dur(t) + 1; return LS[num]; }
    const ss = succ[num] || []; let finish = null;
    ss.forEach(s => { const st = byNum[s]; if (!st) return; const sls = calcLS(s, stack.concat([num])); const cand = sls - 1 - (st.lag||0); if (finish===null||cand<finish) finish=cand; });
    if (finish === null) finish = projectEnd;
    LF[num] = finish; LS[num] = finish - dur(t) + 1; return LS[num];
  }
  tasks.forEach(t => calcLS(t.bt_num, []));
  const isCrit = {}; let criticalCount = 0;
  tasks.forEach(t => { const float = (LS[t.bt_num]||0) - (ES[t.bt_num]||0); const c = (float<=0)||!!t.force_critical; isCrit[t.bt_num]=c; if(c)criticalCount++; });
  return { ES, EF, projectEnd, isCrit, criticalCount };
}

/* =====================================================================
 * OLD-C — backend computeProjected(), ported verbatim from supabase.js L883-939.
 * Tasks: { bt_num, status, actual_start, actual_finish, est_start_date,
 *          relative_start, duration, lag, predecessors, task_order }.
 * Returns { es:{bt_num}, projected_date:{bt_num} }.
 * NOTE: this is the DIVERGENT copy — no negative-lag backward scheduling,
 * no global floor at day 1.
 * ===================================================================== */
function oldBackendProjected(tasks, startDateStr) {
  const bn = {}; tasks.forEach(t => { bn[t.bt_num] = t; });
  const start = startDateStr ? new Date(startDateStr + 'T00:00:00') : null;
  const actOffset = (iso) => (start && iso) ? wdBetween(start, new Date(iso+'T00:00:00'))+1 : null;
  const hasPreds = tasks.some(t => Array.isArray(t.predecessors) && t.predecessors.length > 0);
  const memoEF = {}; const esOut = {}; const dateOut = {};
  function ef(n, stk) {
    if (memoEF[n] !== undefined) return memoEF[n];
    const t = bn[n]; if (!t) return 1;
    if (stk.indexOf(n) >= 0) { esOut[n] = t.relative_start||1; return (t.relative_start||1)+((t.duration||1)-1); }
    const preds = Array.isArray(t.predecessors) ? t.predecessors : [];
    let pd = null;
    preds.forEach(p => { if (bn[p]) { const pe = ef(p, stk.concat([n])); pd = (pd===null)?pe+1:Math.max(pd, pe+1); } });
    const a = { started:(t.status==='started'||t.status==='finished'), finished:(t.status==='finished'), start:t.actual_start, finish:t.actual_finish };
    const aStartOff = (a.started && a.start) ? actOffset(a.start) : null;
    const ps = (pd!==null) ? pd + (t.lag||0) : null;
    let es;
    if (aStartOff !== null) { es = aStartOff; }
    else { es = (ps!==null)?ps:(t.relative_start||1); if (!a.started && t.est_start_date){ const eo=actOffset(t.est_start_date); if(eo!==null) es=Math.max(es,eo); } }
    const aFinOff = (a.finished && a.finish) ? actOffset(a.finish) : null;
    const e = (aFinOff!==null)?aFinOff:es+(t.duration||1)-1;
    esOut[n] = es; memoEF[n] = e; return e;
  }
  if (hasPreds) { tasks.forEach(t => ef(t.bt_num, [])); }
  else {
    const sorted = tasks.slice().sort((a,b)=>((a.relative_start||1)-(b.relative_start||1))||((a.task_order||0)-(b.task_order||0)));
    let maxSlip = 0;
    sorted.forEach(t => {
      const a = { started:(t.status==='started'||t.status==='finished'), finished:(t.status==='finished'), start:t.actual_start, finish:t.actual_finish };
      const aStartOff=(a.started&&a.start)?actOffset(a.start):null;
      const aFinOff=(a.finished&&a.finish)?actOffset(a.finish):null;
      const estOff=(!a.started&&t.est_start_date)?actOffset(t.est_start_date):null;
      let slip=0;
      if(aFinOff!==null)slip=aFinOff-((t.relative_start||1)+(t.duration||1)-1);
      else if(aStartOff!==null)slip=aStartOff-(t.relative_start||1);
      else if(estOff!==null)slip=Math.max(0,estOff-(t.relative_start||1));
      maxSlip=Math.max(maxSlip,slip);
      esOut[t.bt_num]=(t.relative_start||1)+maxSlip;
    });
  }
  tasks.forEach(t => { if (start && esOut[t.bt_num] != null) dateOut[t.bt_num] = ymd(addWD(start, esOut[t.bt_num])); else dateOut[t.bt_num] = null; });
  return { es: esOut, projected_date: dateOut };
}

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
