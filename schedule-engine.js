/*
 * schedule-engine.js — Ashland Field App
 * ---------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for all schedule math. Pure: no DOM, no DB, no
 * side effects. Works BOTH as a browser global (via <script src>) and as a
 * Node/CommonJS module (via require) through the UMD wrapper below.
 *
 * There is exactly ONE definition of each working-day helper in this file.
 * Never define a second addWD / wdBetween anywhere in the codebase — a
 * duplicate wdBetween once shadowed the real one and silently broke every
 * date calc (see BUILD_SPEC §2.2, §6).
 *
 * The math is a faithful extraction of the proven field-app engine
 * (ashland-stage-update.html runEngine, the reference/source-of-truth) plus
 * the force_critical rule from the backend critical-path writer. It is a
 * WORKING-DAY engine: weekends excluded, offset 1 == the construction start
 * date itself.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── working-day / offset helpers (the ONLY copies) ──────────────────────

  // offset 1 == start date; count forward skipping Sat/Sun.
  function addWD(start, off) {
    var d = new Date(start); d.setHours(0, 0, 0, 0); var c = 1;
    while (c < off) { d.setDate(d.getDate() + 1); var w = d.getDay(); if (w !== 0 && w !== 6) c++; }
    return d;
  }

  // signed working-day count between two dates.
  function wdBetween(a, b) {
    var d1 = new Date(a), d2 = new Date(b); d1.setHours(0, 0, 0, 0); d2.setHours(0, 0, 0, 0);
    if (d1.getTime() === d2.getTime()) return 0;
    var sign = d2 > d1 ? 1 : -1; var cur = new Date(d1), c = 0;
    while (cur.getTime() !== d2.getTime()) { cur.setDate(cur.getDate() + sign); var w = cur.getDay(); if (w !== 0 && w !== 6) c += sign; }
    return c;
  }

  function ymd(d) {
    var x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  // wdBetween(start, iso)+1 — the working-day OFFSET of an ISO date. null if unknown.
  function actOffset(iso, startDate) {
    if (!startDate || !iso) return null;
    return wdBetween(startDate, new Date(iso + 'T00:00:00')) + 1;
  }

  // inverse of addWD; must handle off < 1 by walking backward.
  function offToDate(off, startDate) {
    if (off >= 1) return addWD(startDate, off);
    var d = new Date(startDate); d.setHours(0, 0, 0, 0); var c = 1;
    while (c > off) { d.setDate(d.getDate() - 1); var w = d.getDay(); if (w !== 0 && w !== 6) c--; }
    return d;
  }

  // ── task normalization ──────────────────────────────────────────────────
  // Callers pass their native row shapes; we normalize to canonical fields so
  // the engine core reads one vocabulary. Missing fields become null/[].
  function normalizeTask(t) {
    var preds = Array.isArray(t.predecessors) ? t.predecessors
              : (Array.isArray(t.preds) ? t.preds : []);
    var status = t.status || null;
    return {
      num:           (t.num != null ? t.num : t.bt_num),
      name:          t.name || null,
      duration:      (t.duration != null ? t.duration : (t.dur != null ? t.dur : 1)),
      lag:           (t.lag != null ? t.lag : 0),
      predecessors:  preds,
      relativeStart: (t.relativeStart != null ? t.relativeStart
                       : (t.relative_start != null ? t.relative_start
                       : (t.rs != null ? t.rs : null))),
      relativeFinish:(t.relativeFinish != null ? t.relativeFinish
                       : (t.relative_finish != null ? t.relative_finish
                       : (t.rf != null ? t.rf : null))),
      taskType:      t.taskType || t.task_type || 'work',
      status:        status,
      actualStart:   t.actualStart || t.actual_start || (t.act && t.act.start) || null,
      actualFinish:  t.actualFinish || t.actual_finish || (t.act && t.act.finish) || null,
      estStartDate:  t.estStartDate || t.est_start_date || null,
      forceCritical: !!(t.forceCritical || t.force_critical),
      isCritical:    !!(t.isCritical || t.is_critical),
      taskOrder:     (t.taskOrder != null ? t.taskOrder
                       : (t.task_order != null ? t.task_order
                       : (t.order != null ? t.order : 0)))
    };
  }

  function actualsOf(t) {
    var started = (t.status === 'started' || t.status === 'finished');
    var finished = (t.status === 'finished');
    return { started: started, finished: finished, start: t.actualStart, finish: t.actualFinish };
  }

  // ── core: computeSchedule ────────────────────────────────────────────────
  // opts.startDate : Date | 'YYYY-MM-DD' | null  (construction start)
  // opts.mode      : 'planned' | 'projected'     (default 'projected')
  //   planned   — baseline; ignores actuals/est_start_date; runs the CPM
  //               backward pass to produce float + critical set.
  //   projected — honors actual_start/finish (truth, bypass projection) and
  //               est_start_date as a FLOOR; no critical pass (mirrors field app).
  //
  // Returns { end, mode, byNum, tasks:[{ num, es, ef, critical, float, projectedDate }] }
  function computeSchedule(rawTasks, opts) {
    opts = opts || {};
    var mode = opts.mode === 'planned' ? 'planned' : 'projected';
    var startDate = opts.startDate
      ? (opts.startDate instanceof Date ? opts.startDate : new Date(opts.startDate + 'T00:00:00'))
      : null;

    var TASKS = (rawTasks || []).map(normalizeTask);
    var bn = {}; TASKS.forEach(function (t) { bn[t.num] = t; });

    var es = {}, ef = {};
    var hasPreds = TASKS.some(function (t) { return t.predecessors && t.predecessors.length > 0; });

    if (hasPreds) {
      var memo = {};
      var compute = function (n, stk) {
        if (memo[n] !== undefined) return memo[n];
        var t = bn[n];
        if (!t) return 1;
        if (stk.indexOf(n) >= 0) return (t.relativeFinish != null ? t.relativeFinish : 1); // cycle guard (mirrors field app)
        var pd = null;         // forward driver (from predecessor FINISH)
        var backDriver = null; // backward lead-time driver (from predecessor START)
        (t.predecessors || []).forEach(function (p) {
          if (bn[p]) {
            compute(p, stk.concat([n]));
            var pStart = es[p], pFin = ef[p];
            if (t.lag < 0) {
              var candB = pStart + t.lag;             // negative lag => earlier than pred START
              backDriver = (backDriver === null) ? candB : Math.min(backDriver, candB);
            } else {
              var candF = pFin + 1 + t.lag;           // forward from pred FINISH
              pd = (pd === null) ? candF : Math.max(pd, candF);
            }
          }
        });
        var a = actualsOf(t);
        var aStartOff = (mode === 'projected' && a.started && a.start) ? actOffset(a.start, startDate) : null;
        var start;
        if (aStartOff !== null) {
          start = aStartOff;                          // actuals are truth — bypass projection
        } else if (t.lag < 0 && backDriver !== null) {
          start = backDriver;
        } else {
          start = (pd !== null) ? pd : (t.relativeStart != null ? t.relativeStart : 1); // relative_start = FALLBACK only
          if (mode === 'projected' && !a.started && t.estStartDate) {
            var estOff = actOffset(t.estStartDate, startDate);
            if (estOff !== null) start = Math.max(start, estOff);   // est_start_date = FLOOR
          }
        }
        if (start < 1) start = 1;                     // global floor: nothing before construction start. Ever.
        var aFinOff = (mode === 'projected' && a.finished && a.finish) ? actOffset(a.finish, startDate) : null;
        var end = (aFinOff !== null) ? aFinOff : start + t.duration - 1;
        es[n] = start; ef[n] = end; memo[n] = end;
        return end;
      };
      TASKS.forEach(function (t) { compute(t.num, []); });
    } else {
      // No predecessor data anywhere: sequential slip-propagation (mirrors field app).
      var sorted = TASKS.slice().sort(function (a, b) {
        return ((a.relativeStart || 1) - (b.relativeStart || 1)) || ((a.taskOrder || 0) - (b.taskOrder || 0));
      });
      var maxSlip = 0;
      sorted.forEach(function (t) {
        var rs = (t.relativeStart != null ? t.relativeStart : 1);
        if (mode === 'projected') {
          var a = actualsOf(t);
          var aStartOff = (a.started && a.start) ? actOffset(a.start, startDate) : null;
          var aFinOff = (a.finished && a.finish) ? actOffset(a.finish, startDate) : null;
          var estOff = (!a.started && t.estStartDate) ? actOffset(t.estStartDate, startDate) : null;
          var slip = 0;
          if (aFinOff !== null) slip = aFinOff - (rs + t.duration - 1);
          else if (aStartOff !== null) slip = aStartOff - rs;
          else if (estOff !== null) slip = Math.max(0, estOff - rs);
          maxSlip = Math.max(maxSlip, slip);
          es[t.num] = rs + maxSlip;
          ef[t.num] = (aFinOff !== null) ? aFinOff : es[t.num] + t.duration - 1;
        } else {
          es[t.num] = rs;
          ef[t.num] = rs + t.duration - 1;
        }
      });
    }

    var end = TASKS.length ? Math.max.apply(null, TASKS.map(function (t) { return ef[t.num]; })) : 0;

    // ── critical path (planned mode only, mirrors field app + force_critical) ──
    var floatByNum = {}, criticalByNum = {};
    if (mode === 'planned') {
      if (hasPreds) {
        var succ = {}; TASKS.forEach(function (t) { succ[t.num] = []; });
        TASKS.forEach(function (t) { (t.predecessors || []).forEach(function (p) { if (succ[p]) succ[p].push(t.num); }); });
        var lf = {};
        var latef = function (n, stk) {
          if (lf[n] !== undefined) return lf[n];
          if (stk.indexOf(n) >= 0) return end;
          var ss = succ[n];
          var v = (ss.length === 0) ? end
            : Math.min.apply(null, ss.map(function (s) { return latef(s, stk.concat([n])) - bn[s].duration + 1 - 1 - bn[s].lag; }));
          lf[n] = v; return v;
        };
        TASKS.forEach(function (t) {
          var LF = latef(t.num, []);
          var LS = LF - t.duration + 1;
          var fl = LS - es[t.num];
          floatByNum[t.num] = fl;
          criticalByNum[t.num] = (fl <= 0) || t.forceCritical;  // force_critical ADDS, never removes
        });
      } else {
        TASKS.forEach(function (t) {
          var LS = end - t.duration + 1;
          var fl = LS - es[t.num];
          floatByNum[t.num] = fl;
          criticalByNum[t.num] = (fl <= 0) || t.forceCritical || t.isCritical;
        });
      }
    }

    var out = TASKS.map(function (t) {
      return {
        num: t.num,
        es: es[t.num],
        ef: ef[t.num],
        float: (mode === 'planned') ? floatByNum[t.num] : null,
        critical: (mode === 'planned') ? !!criticalByNum[t.num] : null,
        projectedDate: (startDate && es[t.num] != null) ? ymd(addWD(startDate, es[t.num])) : null
      };
    });

    var byNum = {}; out.forEach(function (r) { byNum[r.num] = r; });
    return { end: end, mode: mode, byNum: byNum, tasks: out };
  }

  // ── integrity rules (BUILD_SPEC §3) — used by template builder + runtime ──
  // Returns [{ num, rule, message }]. Does not throw; the UI decides how to
  // surface / block on these.
  function validateSchedule(rawTasks, opts) {
    opts = opts || {};
    var startTaskNum = (opts.startTaskNum != null) ? opts.startTaskNum : null;
    var TASKS = (rawTasks || []).map(normalizeTask);
    var present = {}; TASKS.forEach(function (t) { present[t.num] = true; });
    var violations = [];

    TASKS.forEach(function (t) {
      var preds = t.predecessors || [];

      // Rule 1: every task must have >= 1 predecessor, except the single designated start task.
      if (preds.length === 0 && t.num !== startTaskNum) {
        violations.push({ num: t.num, rule: 'needs_predecessor',
          message: 'Task ' + t.num + ' (' + (t.name || '') + ') has no predecessor. Every task except the project-start task must be chained.' });
      }

      // Rule 3: negative lag (lead time) requires its driving predecessor to already exist.
      if (t.lag < 0) {
        if (preds.length === 0) {
          violations.push({ num: t.num, rule: 'neg_lag_no_pred',
            message: 'Task ' + t.num + ' has negative lag (lead time) but no predecessor to lead off of.' });
        } else {
          preds.forEach(function (p) {
            if (!present[p]) {
              violations.push({ num: t.num, rule: 'neg_lag_missing_driver',
                message: 'Task ' + t.num + ' leads off predecessor ' + p + ' which does not exist. Build the driver task first.' });
            }
          });
        }
      }
    });

    return violations;
  }

  // ── stage codes & gates (BUILD_SPEC §2.7) ─────────────────────────────────
  // stageMap: [{ code, label, order, is_manual, triggers:[bt_num] }]
  // finishedByNum: { [bt_num]: true } for finished tasks
  // gateState: { open: bool, manualCode: string|null }
  function computeStage(stageMap, finishedByNum, gateState) {
    stageMap = stageMap || [];
    finishedByNum = finishedByNum || {};
    gateState = gateState || {};
    var achieved = stageMap.filter(function (s) {
      return !s.is_manual && s.triggers && s.triggers.length &&
        s.triggers.every(function (bt) { return finishedByNum[bt]; });
    });
    var trueStage = null;
    achieved.forEach(function (s) { if (!trueStage || s.order > trueStage.order) trueStage = s; });
    if (!trueStage && gateState.manualCode) {
      trueStage = stageMap.filter(function (s) { return s.code === gateState.manualCode; })[0]
        || { code: gateState.manualCode, label: 'Pre-construction', order: 0 };
    }
    var gatesOpen = !!gateState.open;
    var held = false, reportedCode, reportedLabel;
    if (trueStage && gatesOpen && parseFloat(trueStage.code) > 5.9) {
      held = true; reportedCode = '5.9'; reportedLabel = 'Utility Hold';
    } else {
      reportedCode = trueStage ? trueStage.code : '—';
      reportedLabel = trueStage ? trueStage.label : 'Pre-construction';
    }
    return {
      reportedCode: reportedCode, reportedLabel: reportedLabel, held: held,
      trueCode: trueStage ? trueStage.code : null,
      trueLabel: trueStage ? trueStage.label : null,
      gatesOpen: gatesOpen
    };
  }

  return {
    // helpers
    addWD: addWD, wdBetween: wdBetween, actOffset: actOffset, offToDate: offToDate, ymd: ymd,
    // normalization (exposed for callers/tests)
    normalizeTask: normalizeTask,
    // core
    computeSchedule: computeSchedule,
    validateSchedule: validateSchedule,
    computeStage: computeStage
  };
}));
