'use strict';
// The finish-time "Unfinished predecessors" warning must be LAG-AWARE: skip it for a
// negative-lag (lead-time) task (which legitimately finishes before its predecessor),
// keep it for zero/positive-lag (a real out-of-sequence finish). This extracts the REAL
// decision line from finishTask (the sole place the warning fires) and runs it.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');

// Pull the actual `const incompletePreds=...;` line out of the source and run it.
const m = html.match(/const incompletePreds=.*?;/);
if (!m) { console.log('could not find the incompletePreds line'); process.exit(2); }
const LINE = m[0];
const decide = new Function('t','bn','act', LINE + ' return incompletePreds;');

// scenario helpers: task with a lag + one predecessor #10; predecessor exists in bn.
const bn = { 10: { num:10, name:'Framing Material Drop' } };
const predUnfinished = { 10: { started:true, finished:false } };
const predFinished   = { 10: { started:true, finished:true  } };
const task = (lag) => ({ num:20, name:'Framing', preds:[10], lag });

let pass=0, fail=0;
const warns = (t, act) => decide(t, bn, act).length > 0;
const is=(n,g,w)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+g+' want '+w));};

// NEGATIVE lag (lead-time) + predecessor NOT finished -> NO warning (the bug).
is('neg-lag, predecessor unfinished -> NO warning (the reported bug, fixed)', warns(task(-6), predUnfinished), false);
// NEGATIVE lag + predecessor finished -> still no warning (nothing incomplete anyway).
is('neg-lag, predecessor finished -> no warning', warns(task(-6), predFinished), false);

// ZERO lag + predecessor NOT finished -> warning STILL fires (real out-of-sequence).
is('zero-lag, predecessor unfinished -> warning fires', warns(task(0), predUnfinished), true);
// POSITIVE lag + predecessor NOT finished -> warning STILL fires.
is('pos-lag, predecessor unfinished -> warning fires', warns(task(3), predUnfinished), true);
// POSITIVE lag + predecessor finished -> no warning (nothing incomplete).
is('pos-lag, predecessor finished -> no warning', warns(task(3), predFinished), false);
// NULL lag (defaults to 0) + predecessor unfinished -> warning fires (treated as zero).
is('null-lag (=>0), predecessor unfinished -> warning fires', warns(task(null), predUnfinished), true);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
