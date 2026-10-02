'use strict';
// validateSchedule (extended) — structure integrity for the lot-structure push.
// BLOCKERS: dangling_predecessor, cycle. WARNINGS: orphan_no_predecessor /
// multiple_sources, neg_lag_no_pred, unreachable_terminal. Runs the REAL engine.
const E = require('../schedule-engine.js');

let pass = 0, fail = 0;
function is(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? '  ok  - ' : '  FAIL- ') + name + (ok ? '' : '  got ' + got + ' want ' + want));
}
const has = (arr, rule, num) => arr.some(v => v.rule === rule && (num === undefined || v.num === num));

// chain: 10 -> 20 -> 30 (30 is the sink/terminal). Clean.
const clean = [
  { bt_num:10, name:'Start', predecessors:[],   lag:0, duration:1 },
  { bt_num:20, name:'Mid',   predecessors:[10], lag:0, duration:1 },
  { bt_num:30, name:'End',   predecessors:[20], lag:0, duration:1 },
];
let r = E.validateSchedule(clean, { startTaskNum:10 });
is('clean: no blockers', r.blockers.length, 0);
is('clean: no warnings', r.warnings.length, 0);

// dangling: 20 depends on 99 which is absent -> BLOCK.
r = E.validateSchedule([
  { bt_num:10, name:'Start', predecessors:[],      lag:0 },
  { bt_num:20, name:'Mid',   predecessors:[10,99], lag:0 },
  { bt_num:30, name:'End',   predecessors:[20],    lag:0 },
], { startTaskNum:10 });
is('dangling: blocker raised', has(r.blockers, 'dangling_predecessor', 20), true);

// cycle: 20 <-> 30 (20 dep 30, 30 dep 20) -> BLOCK.
r = E.validateSchedule([
  { bt_num:10, name:'Start', predecessors:[],   lag:0 },
  { bt_num:20, name:'A',     predecessors:[30], lag:0 },
  { bt_num:30, name:'B',     predecessors:[20], lag:0 },
], { startTaskNum:10 });
is('cycle: blocker raised', has(r.blockers, 'cycle'), true);

// dead-end: 40 hangs off 10 but nothing follows it, and terminal is 30 -> WARNING, not block.
r = E.validateSchedule([
  { bt_num:10, name:'Start', predecessors:[],   lag:0 },
  { bt_num:20, name:'Mid',   predecessors:[10], lag:0 },
  { bt_num:30, name:'End',   predecessors:[20], lag:0 },
  { bt_num:40, name:'Float', predecessors:[10], lag:0 },
], { startTaskNum:10, terminalTaskNum:30 });
is('dead-end: unreachable_terminal warning on 40', has(r.warnings, 'unreachable_terminal', 40), true);
is('dead-end: NOT a blocker', r.blockers.length, 0);

// multiple sources (no designated start): 10 and 15 both have no predecessor -> WARNING.
r = E.validateSchedule([
  { bt_num:10, name:'S1', predecessors:[],   lag:0 },
  { bt_num:15, name:'S2', predecessors:[],   lag:0 },
  { bt_num:20, name:'End',predecessors:[10,15], lag:0 },
]);
is('multiple_sources: warning raised', has(r.warnings, 'multiple_sources'), true);
is('multiple_sources: NOT a blocker', r.blockers.length, 0);

// orphan (designated start = 10): 15 has no predecessor and isn't the start -> WARNING.
r = E.validateSchedule([
  { bt_num:10, name:'Start', predecessors:[],   lag:0 },
  { bt_num:15, name:'Orphan',predecessors:[],   lag:0 },
  { bt_num:20, name:'End',   predecessors:[10,15], lag:0 },
], { startTaskNum:10 });
is('orphan_no_predecessor: warning on 15', has(r.warnings, 'orphan_no_predecessor', 15), true);

// neg-lag with no predecessor -> WARNING (not a dangling/cycle block).
r = E.validateSchedule([
  { bt_num:10, name:'Start', predecessors:[],  lag:0 },
  { bt_num:20, name:'Lead',  predecessors:[],  lag:-6 },
], { startTaskNum:10 });
is('neg_lag_no_pred: warning raised', has(r.warnings, 'neg_lag_no_pred', 20), true);
is('neg_lag_no_pred: NOT a blocker', r.blockers.length, 0);

console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASS') + ' (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
