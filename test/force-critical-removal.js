/*
 * Proof that force_critical is FULLY REMOVED from the critical computation.
 * The engine now computes is_critical = pure CPM float <= 0, ignoring any
 * force_critical value on the input. So recalcTemplateCriticalPath lands on the
 * same 36 the migration set manually — force_critical is inert.
 *
 * Runs against the real Slab graph (fixture, verified identical to a live
 * dev_sched_template_tasks dump on 2026-08-07: 129 tasks, 0 structural diffs).
 */
'use strict';
const Engine = require('../schedule-engine.js');
const fixture = require('./fixtures/template_tasks.json');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

// recalcTemplateCriticalPath routes through this. Try it three ways: force as
// stored, all-true, all-false — the critical set must be identical every time.
const run = mode => Engine.computeTemplateCritical(fixture.map(r => ({
  id: r.bt_num, bt_num: r.bt_num, duration: r.duration, lag: r.lag,
  relative_start: r.relative_start, predecessors: r.predecessors,
  force_critical: mode === 'stored' ? r.force_critical : (mode === 'all'),
})));

const stored = run('stored'), allTrue = run('all'), allFalse = run('none');
const set = res => res.updates.filter(u => u.is_critical).map(u => u.bt_num).sort((a,b)=>a-b);
const sStored = set(stored), sTrue = set(allTrue), sFalse = set(allFalse);

// The verified pure-float set (float <= 0) = the 36 the migration keeps.
const THE_36 = [2,4,6,7,9,11,14,16,17,18,21,25,30,35,37,43,52,55,60,63,68,73,97,98,101,118,126,133,136,137,141,142,144,145,147,148];

console.log('\n===== force_critical fully removed — engine ignores it =====\n');
console.log('  is_critical count  | force as stored:', sStored.length,
            ' | all force=true:', sTrue.length, ' | all force=false:', sFalse.length);
console.log('  projectEnd:', stored.projectEnd);
console.log('');

const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
check('force_critical is INERT: critical set identical regardless of the flag', eq(sStored, sTrue) && eq(sStored, sFalse));
check('recalc lands on 36 (pure float <= 0), not 51', sStored.length === 36);
check('the 36 set === the verified float-critical set the migration keeps', eq(sStored, THE_36));
check('setting every task force_critical=true still yields 36 (flag cannot force anything)', sTrue.length === 36);
check('projectEnd unchanged (94)', stored.projectEnd === 94);
// none of the 15 previously-force-only tasks are critical anymore
const THE_15 = [62,69,71,79,84,88,92,95,99,104,108,110,119,123,140];
check('none of the 15 old force-only tasks are critical', THE_15.every(n => !sStored.includes(n)));

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
