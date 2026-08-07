/*
 * Proof for sql/2026-08-07_remove_force_critical.sql — clearing force_critical on
 * the real Slab graph. Shows the before/after and confirms:
 *   - backend is_critical drops 51 -> 36
 *   - the 36 backend set === the field app's _crit (pure float) set, exactly
 *   - the 15 dropped tasks all have genuine positive float (no dot, no delay nag)
 *   - the engine runs clean with force_critical all-false (nothing errors)
 *   - projectEnd unchanged (94)
 * Runs against the real fixture (egress-blocked from live; owner runs the SQL).
 */
'use strict';
const path = require('path');
const Engine = require('../schedule-engine.js');
const fixture = require('./fixtures/template_tasks.json');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

// backend adapter (float<=0 OR force_critical) — mirrors recalcTemplateCriticalPath
const backend = force => Engine.computeTemplateCritical(fixture.map(r => ({
  id: r.bt_num, bt_num: r.bt_num, duration: r.duration, lag: r.lag,
  relative_start: r.relative_start, predecessors: r.predecessors,
  force_critical: force ? r.force_critical : false,
})));

const THE_15 = [62,69,71,79,84,88,92,95,99,104,108,110,119,123,140];

let before, after, errored = null;
try {
  before = backend(true);    // as stored today
  after  = backend(false);   // after the migration clears force_critical
} catch (e) { errored = e; }

const floatBy = {}; (after ? after.updates : []).forEach(u => floatBy[u.bt_num] = u.float);
// field _crit = pure float<=0 (force_critical never sourced in the field app)
const fieldCrit = new Set((after ? after.updates : []).filter(u => u.float <= 0).map(u => u.bt_num));
const backendAfter = new Set((after ? after.updates : []).filter(u => u.is_critical).map(u => u.bt_num));
const backendBefore = (before ? before.criticalCount : -1);

console.log('\n===== force_critical removal — Slab (real graph) =====\n');
console.log('  BEFORE (stored)         is_critical =', backendBefore);
console.log('  AFTER  (force cleared)  is_critical =', backendAfter.size);
console.log('  field _crit (float<=0)              =', fieldCrit.size);
console.log('  projectEnd:', before && before.projectEnd, '->', after && after.projectEnd);
console.log('');

check('engine runs clean with force_critical all-false (no throw)', errored === null);
check('BEFORE is_critical = 51', backendBefore === 51);
check('AFTER is_critical = 36', backendAfter.size === 36);
check('field _crit = 36', fieldCrit.size === 36);
const sameSet = backendAfter.size === fieldCrit.size && [...backendAfter].every(n => fieldCrit.has(n));
check('backend AFTER set === field _crit set (KI-1 closed: both agree)', sameSet);
check('projectEnd unchanged (94 -> 94)', before && after && before.projectEnd === 94 && after.projectEnd === 94);

// the 15 that drop out: each must have float>0, no red dot, no delay-trigger membership
let all15Float = true, none15Dotted = true;
THE_15.forEach(n => { if (!(floatBy[n] > 0)) all15Float = false; if (fieldCrit.has(n)) none15Dotted = false; });
check('all 15 dropped tasks have genuine positive float', all15Float);
check('none of the 15 are in _crit (no red dot, no delay nag)', none15Dotted);

// exact dropped set == THE_15
const beforeSet = new Set((before ? before.updates : []).filter(u => u.is_critical).map(u => u.bt_num));
const actualDrops = [...beforeSet].filter(n => !backendAfter.has(n)).sort((a,b)=>a-b);
check('the tasks that drop are exactly the 15 [62,69,71,79,84,88,92,95,99,104,108,110,119,123,140]',
  JSON.stringify(actualDrops) === JSON.stringify(THE_15));

console.log('\n  the 15 (now normal float-having tasks):');
THE_15.forEach(n => {
  const r = fixture.find(x => x.bt_num === n);
  console.log('     #' + String(n).padStart(3) + ' float=+' + floatBy[n] + '  ' + r.name);
});

if (errored) { console.log('\nENGINE ERROR:', errored && errored.stack); }
console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
