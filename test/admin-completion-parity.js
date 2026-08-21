/*
 * KI-2 proof — the admin completion date now comes from the ONE engine over the
 * lot's stamped schedule, identical to the field app, and MOVES when an est
 * override changes. Replaces the deleted flat-99 calcPlannedCompletion.
 *
 * Two paths, one algorithm:
 *   ADMIN  : ScheduleEngine.computeLotSchedule(lotTasks, start)  (backend getAllLotPhases)
 *   FIELD  : ScheduleEngine.computeFieldSchedule(TASKS, act, start, mode).end  (browser)
 * Both must yield the SAME projected completion and the SAME planned baseline,
 * because both normalize to computeSchedule. Proven on the real Slab template.
 */
'use strict';
const Engine = require('../schedule-engine.js');
const tmpl = require('./fixtures/template_tasks.json');
const START = '2026-07-14';

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

// Build the two shapes from ONE set of stamped tasks so the only difference is
// the code path, never the data.
const lotTasks = () => tmpl.map(t => ({
  bt_num: t.bt_num, name: t.name, duration: t.duration, lag: t.lag,
  predecessors: t.predecessors, relative_start: t.relative_start,
  status: 'not_started', actual_start: null, actual_finish: null, est_start_date: null,
}));
const fieldTasks = (lts) => lts.map(t => ({
  num: t.bt_num, name: t.name, dur: t.duration, lag: t.lag, preds: t.predecessors,
  rs: t.relative_start, type: 'work', est_start_date: t.est_start_date,
}));
// field app's projected/planned end -> YYYY-MM-DD, via the same engine helpers
const fieldEndDate = (lts, mode) => {
  const sd = new Date(START + 'T00:00:00');
  const end = Engine.computeFieldSchedule(fieldTasks(lts), {}, sd, mode).end;
  return Engine.ymd(Engine.offToDate(end, sd));
};

console.log('\n===== KI-2 — admin completion == field app, from the one engine =====\n');

// ── 1) PARITY: admin computeLotSchedule == field computeFieldSchedule ──
{
  const lts = lotTasks();
  const admin = Engine.computeLotSchedule(lts, START);
  const fieldProj = fieldEndDate(lts, 'projected');
  const fieldPlan = fieldEndDate(lts, 'planned');
  console.log('   admin  projEndDate=' + admin.projEndDate + '  planEndDate=' + admin.planEndDate);
  console.log('   field  projEndDate=' + fieldProj      + '  planEndDate=' + fieldPlan);
  check('admin projected completion === field app projected completion', admin.projEndDate === fieldProj);
  check('admin planned baseline === field app planned baseline',         admin.planEndDate === fieldPlan);
  check('projEndDate is a real date, not null',                          !!admin.projEndDate);
}

// ── 2) NOT FROZEN: an est override on the root MOVES projected, NOT baseline ──
{
  const before = Engine.computeLotSchedule(lotTasks(), START);
  const lts = lotTasks();
  // floor the schedule root (#2 Silt Fence) 2 weeks out — the WI Lot 1 mechanic
  lts.find(t => t.bt_num === 2).est_start_date = '2026-07-28';
  const after = Engine.computeLotSchedule(lts, START);
  console.log('\n   root est_start_date null  -> proj ' + before.projEndDate + ' | base ' + before.planEndDate);
  console.log('   root est_start_date 7/28  -> proj ' + after.projEndDate  + ' | base ' + after.planEndDate);
  check('projected completion MOVES later when the root est is pushed out (not frozen)',
    after.projEndDate > before.projEndDate);
  check('planned BASELINE is unchanged by est (baseline ignores overrides)',
    after.planEndDate === before.planEndDate);
}

// ── 3) The deleted flat-99 was genuinely WRONG (proves this wasn't cosmetic) ──
{
  const admin = Engine.computeLotSchedule(lotTasks(), START);
  const flat99 = Engine.ymd(Engine.addWD(new Date(START + 'T00:00:00'), 100)); // old calcPlannedCompletion
  console.log('\n   real engine baseline=' + admin.planEndDate + '   old flat-99=' + flat99);
  check('old flat-99 date DIFFERS from the real engine baseline (bug was real)',
    flat99 !== admin.planEndDate);
}

// ── 4) No construction start -> null dates (no crash, no fabricated date) ──
{
  const admin = Engine.computeLotSchedule(lotTasks(), null);
  check('null construction start -> null completion dates (no fabrication)',
    admin.planEndDate === null && admin.projEndDate === null);
}

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
