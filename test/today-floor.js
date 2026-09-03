/*
 * TODAY-FLOOR proof (KI-9) — a not-started task can't be projected into the past.
 * ---------------------------------------------------------------------------
 * A not-started/not-finished task whose computed projected start is BEFORE today is
 * floored to today (the earliest it could still begin); the floor cascades to
 * downstream tasks. Tasks with actuals (started/finished) and tasks already projected
 * in the future are untouched, and an on-track lot is byte-identical with/without the
 * floor. Planned (baseline) mode ignores today entirely.
 *
 * Pure Node against the real schedule-engine.js. `today` is an explicit input (pinned
 * here — no hidden clock), passed via computeSchedule opts.today.
 */
'use strict';
const E = require('../schedule-engine.js');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

const cs = '2026-01-05';                       // construction start (Mon)
const csD = new Date(cs + 'T00:00:00');
const today = '2026-03-02';                    // ~8 weeks later (Mon)
const todayOff = E.actOffset(today, csD);      // working-day offset of today from cs

// ── Scenario A: predecessor FINISHED in the PAST, successor NOT started ──
const tasksA = [
  { num:1, name:'Anchor',     duration:2, lag:0, predecessors:[],  relative_start:1, status:'finished', actual_start:cs, actual_finish:'2026-01-06' },
  { num:2, name:'Stuck',      duration:2, lag:0, predecessors:[1], status:'not_started' },
  { num:3, name:'Downstream', duration:3, lag:0, predecessors:[2], status:'not_started' },
];
const baseA  = E.computeSchedule(tasksA, { startDate: cs, mode:'projected' });            // no today -> floor OFF
const floorA = E.computeSchedule(tasksA, { startDate: cs, mode:'projected', today });     // today  -> floor ON

// ── Scenario B: on-track — everything not-started projects into the FUTURE ──
const tasksB = [
  { num:1, name:'Anchor', duration:60, lag:0, predecessors:[],  relative_start:1, status:'started', actual_start:today }, // 60wd, finishes far ahead
  { num:2, name:'Next',   duration:5,  lag:0, predecessors:[1], status:'not_started' },
  { num:3, name:'Later',  duration:5,  lag:0, predecessors:[2], status:'not_started' },
];
const baseB  = E.computeSchedule(tasksB, { startDate: cs, mode:'projected' });
const floorB = E.computeSchedule(tasksB, { startDate: cs, mode:'projected', today });

// ── planned mode must ignore today ──
const planNo  = E.computeSchedule(tasksA, { startDate: cs, mode:'planned' });
const planYes = E.computeSchedule(tasksA, { startDate: cs, mode:'planned', today });

console.log('\n===== TODAY-FLOOR (real schedule-engine) — today=' + today + ' (offset ' + todayOff + ') =====\n');
console.log('  A baseline (no floor): ' + JSON.stringify(baseA.byNum) );
console.log('  A floored (today)    : ' + JSON.stringify(floorA.byNum) );
console.log('  B on-track base==floor per task: ' + tasksB.map(t=>t.num+':'+(baseB.byNum[t.num].es===floorB.byNum[t.num].es)).join(' '));
console.log('');

// (a) stuck-in-past floors + cascades
check('A: without floor, the not-started task IS stuck in the past (es < today)', baseA.byNum[2].es < todayOff);
check('A: with floor, the not-started task starts TODAY (es === today offset)', floorA.byNum[2].es === todayOff);
check('A: floored task end derives from the floored start (ef = es + dur - 1)', floorA.byNum[2].ef === floorA.byNum[2].es + 2 - 1);
check('A: CASCADE — downstream starts right after the floored predecessor', floorA.byNum[3].es === floorA.byNum[2].ef + 1);
check('A: CASCADE — downstream moved FORWARD vs baseline', floorA.byNum[3].es > baseA.byNum[3].es);
check('A: FINISHED predecessor is untouched by the floor', floorA.byNum[1].es === baseA.byNum[1].es && floorA.byNum[1].ef === baseA.byNum[1].ef);

// (b) on-track lot is byte-identical
check('B: on-track lot UNCHANGED — every es identical with/without floor',
  tasksB.every(t => baseB.byNum[t.num].es === floorB.byNum[t.num].es));
check('B: on-track lot UNCHANGED — every ef identical with/without floor',
  tasksB.every(t => baseB.byNum[t.num].ef === floorB.byNum[t.num].ef));
check('B: STARTED task uses its actual start (not floored)', floorB.byNum[1].es === E.actOffset(today, csD));

// planned mode unaffected
check('PLANNED mode ignores today (es identical)', tasksA.every(t => planNo.byNum[t.num].es === planYes.byNum[t.num].es));
check('PLANNED mode ignores today (critical set identical)', tasksA.every(t => planNo.byNum[t.num].critical === planYes.byNum[t.num].critical));

// adapter threads today (field-app path)
const fa = E.computeFieldSchedule(
  [{num:1,dur:2,lag:0,preds:[],rs:1},{num:2,dur:2,lag:0,preds:[1]}],
  {1:{started:true,finished:true,start:cs,finish:'2026-01-06'},2:{started:false,finished:false}},
  cs, 'projected', today);
check('ADAPTER: computeFieldSchedule threads today (not-started task floors to today)', fa.byNum[2].es === todayOff);

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
