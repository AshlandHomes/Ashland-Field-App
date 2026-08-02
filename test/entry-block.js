/*
 * test/entry-block.js — proves the actual-date entry guard (ScheduleEngine.validateActual).
 * Rule: construction_start <= actual <= today, and finish >= start. Blocks the two
 * impossible classes (pre-construction, future) while ALLOWING legitimate backdating.
 */
'use strict';
const Engine = require('../schedule-engine.js');
const G='\x1b[32m', R='\x1b[31m', X='\x1b[0m';
let pass = 0, fail = 0;
function check(label, got, wantOk, wantReason) {
  const okMatch = got.ok === wantOk;
  const reasonMatch = wantOk ? true : (got.reason === wantReason);
  const good = okMatch && reasonMatch;
  if (good) pass++; else fail++;
  console.log('  [' + (good ? G+'PASS'+X : R+'FAIL'+X) + '] ' + label +
    (good ? '' : '  -> got ' + JSON.stringify({ok:got.ok, reason:got.reason})));
}

const CS = '2026-07-13';   // construction start
const TODAY = '2026-08-02';

console.log('\n===== ENTRY-BLOCK (ScheduleEngine.validateActual) =====');

// Brendon's exact loophole: April 8 finish, months before construction start
check("Brendon's April-8 finish (before construction start) is BLOCKED",
  Engine.validateActual({actualFinish:'2026-04-08', constructionStart:CS, today:TODAY}), false, 'before_start');

// before construction start (start date)
check('actual_start before construction start BLOCKED',
  Engine.validateActual({actualStart:'2026-07-01', constructionStart:CS, today:TODAY}), false, 'before_start');

// future dates
check('actual_finish in the future BLOCKED',
  Engine.validateActual({actualFinish:'2026-08-15', constructionStart:CS, today:TODAY}), false, 'future');
check('actual_start in the future BLOCKED',
  Engine.validateActual({actualStart:'2026-08-03', constructionStart:CS, today:TODAY}), false, 'future');

// finish before start
check('actual_finish before actual_start BLOCKED',
  Engine.validateActual({actualStart:'2026-07-20', actualFinish:'2026-07-18', constructionStart:CS, today:TODAY}), false, 'finish_before_start');

// LEGITIMATE cases that must be ALLOWED
check('legitimate backdating inside window ALLOWED (real past work)',
  Engine.validateActual({actualFinish:'2026-07-20', constructionStart:CS, today:TODAY}), true);
check('start = construction start day ALLOWED (boundary)',
  Engine.validateActual({actualStart:CS, constructionStart:CS, today:TODAY}), true);
check('finish = today ALLOWED (boundary)',
  Engine.validateActual({actualFinish:TODAY, constructionStart:CS, today:TODAY}), true);
check('valid start+finish pair (start<=finish, both in window) ALLOWED',
  Engine.validateActual({actualStart:'2026-07-15', actualFinish:'2026-07-28', constructionStart:CS, today:TODAY}), true);
check('clearing to null ALLOWED (no dates)',
  Engine.validateActual({actualStart:null, actualFinish:null, constructionStart:CS, today:TODAY}), true);
check('no construction_start known -> skip before-start check, future still enforced',
  Engine.validateActual({actualFinish:'2026-08-15', constructionStart:null, today:TODAY}), false, 'future');

console.log('===== ' + (fail===0 ? G+'ALL PASS' : R+fail+' FAILED') + X + '  ('+pass+'/'+(pass+fail)+') =====');
process.exit(fail===0 ? 0 : 1);
