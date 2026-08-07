/*
 * test/old-engines.js — verbatim snapshots of the THREE pre-restructure engines,
 * shared by every parity/wiring test so there is one reference implementation.
 *   oldFieldEngine       — field app runEngine() (ashland-stage-update-dev.html) — SOURCE OF TRUTH
 *   oldBackendTemplate   — backend calcEF/calcLS  (supabase.js recomputeTemplateCritical)
 *   oldBackendProjected  — backend computeProjected (supabase.js getAllLotPhases) — the divergent copy
 * Plus the working-day helpers identical to both old engines.
 */
'use strict';

function wdBetween(a, b) {
  let d1 = new Date(a), d2 = new Date(b); d1.setHours(0,0,0,0); d2.setHours(0,0,0,0);
  if (d1.getTime() === d2.getTime()) return 0;
  const sign = d2 > d1 ? 1 : -1; let cur = new Date(d1), c = 0;
  while (cur.getTime() !== d2.getTime()) { cur.setDate(cur.getDate()+sign); const w = cur.getDay(); if (w!==0&&w!==6) c+=sign; }
  return c;
}
function addWD(start, off){ let d=new Date(start); d.setHours(0,0,0,0); let c=1; while(c<off){d.setDate(d.getDate()+1);const w=d.getDay();if(w!==0&&w!==6)c++;} return d; }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// OLD-A — field app runEngine(), ported verbatim from ashland-stage-update-dev.html L495-581.
function oldFieldEngine(TASKS, startDate, mode) {
  TASKS = TASKS.map(t => Object.assign({}, t));
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

// OLD-B — backend calcEF/calcLS, ported verbatim from supabase.js L416-501.
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
  // Pure CPM float ≤ 0. force_critical was removed entirely (owner decision
  // 2026-08-07); this snapshot tracks that so parity stays a meaningful guard.
  tasks.forEach(t => { const float = (LS[t.bt_num]||0) - (ES[t.bt_num]||0); const c = (float<=0); isCrit[t.bt_num]=c; if(c)criticalCount++; });
  return { ES, EF, projectEnd, isCrit, criticalCount };
}

// OLD-C — backend computeProjected(), ported verbatim from supabase.js L883-939.
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

module.exports = { wdBetween, addWD, ymd, oldFieldEngine, oldBackendTemplate, oldBackendProjected };
