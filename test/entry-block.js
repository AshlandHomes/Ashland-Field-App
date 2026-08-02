/*
 * test/entry-block.js — proves the date-entry guard (ScheduleEngine.validateDateEntry).
 * Two rules by field type:
 *   actuals (actual_start/finish): construction_start <= date <= today, finish >= start.
 *   est_start_date (override):      construction_start <= date  (FUTURE allowed).
 */
'use strict';
const Engine = require('../schedule-engine.js');
const G='\x1b[32m', R='\x1b[31m', X='\x1b[0m';
let pass = 0, fail = 0;
function check(label, got, wantOk, wantReason) {
  const good = got.ok === wantOk && (wantOk ? true : got.reason === wantReason);
  if (good) pass++; else fail++;
  console.log('  [' + (good ? G+'PASS'+X : R+'FAIL'+X) + '] ' + label +
    (good ? '' : '  -> got ' + JSON.stringify({ok:got.ok, reason:got.reason})));
}
const CS = '2026-07-13', TODAY = '2026-08-02';
const V = Engine.validateDateEntry;

console.log('\n===== ENTRY-BLOCK (validateDateEntry) =====');
console.log('  -- ACTUALS: full window [construction_start, today] --');
check("Brendon's Apr-8 finish (before start) BLOCKED", V({actualFinish:'2026-04-08', constructionStart:CS, today:TODAY}), false, 'before_start');
check('actual_start before start BLOCKED', V({actualStart:'2026-07-01', constructionStart:CS, today:TODAY}), false, 'before_start');
check('actual_finish in future BLOCKED', V({actualFinish:'2026-08-15', constructionStart:CS, today:TODAY}), false, 'future');
check('actual_start in future BLOCKED', V({actualStart:'2026-08-03', constructionStart:CS, today:TODAY}), false, 'future');
check('legitimate backdating inside window ALLOWED', V({actualFinish:'2026-07-20', constructionStart:CS, today:TODAY}), true);
check('start = construction start ALLOWED (boundary)', V({actualStart:CS, constructionStart:CS, today:TODAY}), true);
check('finish = today ALLOWED (boundary)', V({actualFinish:TODAY, constructionStart:CS, today:TODAY}), true);

console.log('  -- finish >= start (incl. priorStart for finish-only writes) --');
check('finish before start (both set) BLOCKED', V({actualStart:'2026-07-20', actualFinish:'2026-07-18', constructionStart:CS, today:TODAY}), false, 'finish_before_start');
check('finish before EXISTING start (priorStart) BLOCKED', V({actualFinish:'2026-07-16', priorStart:'2026-07-20', constructionStart:CS, today:TODAY}), false, 'finish_before_start');
check('finish after existing start ALLOWED', V({actualFinish:'2026-07-28', priorStart:'2026-07-20', constructionStart:CS, today:TODAY}), true);
check('finish OK even when priorStart is LEGACY-BAD (not re-validated)', V({actualFinish:'2026-07-28', priorStart:'2026-04-08', constructionStart:CS, today:TODAY}), true);

console.log('  -- est_start_date OVERRIDE: construction floor only, FUTURE allowed --');
check('est before construction start BLOCKED', V({estStartDate:'2026-07-01', constructionStart:CS, today:TODAY}), false, 'before_start');
check('est in the FUTURE ALLOWED (the key distinction)', V({estStartDate:'2026-09-15', constructionStart:CS, today:TODAY}), true);
check('est = construction start ALLOWED (boundary)', V({estStartDate:CS, constructionStart:CS, today:TODAY}), true);
check('est today/near-future ALLOWED', V({estStartDate:'2026-08-20', constructionStart:CS, today:TODAY}), true);

console.log('  -- misc --');
check('clearing everything to null ALLOWED', V({actualStart:null, actualFinish:null, estStartDate:null, constructionStart:CS, today:TODAY}), true);
check('no construction_start -> skip floor, actuals future still enforced', V({actualFinish:'2026-08-15', constructionStart:null, today:TODAY}), false, 'future');

console.log('===== ' + (fail===0 ? G+'ALL PASS' : R+fail+' FAILED') + X + '  ('+pass+'/'+(pass+fail)+') =====');
process.exit(fail===0 ? 0 : 1);
