/*
 * test/successors.js — proves the derived reverse map + orphan detection + lag
 * behavior labels, on the REAL Slab template.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../schedule-engine.js');
const G='\x1b[32m', R='\x1b[31m', X='\x1b[0m', ok=b=>b?G+'PASS'+X:R+'FAIL'+X;

const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/template_tasks.json'), 'utf8'));
const byNum = {}; tasks.forEach(t => byNum[t.bt_num] = t);
const succ = Engine.computeSuccessors(tasks);
let allPass = true;

console.log('\n===== SUCCESSORS / DEPENDENTS (real Slab template) =====');

// 1) #71 Drywall Installation — the owner's example
console.log('\n#71 Drywall Installation — dependents:');
succ[71].forEach(s => console.log('   #' + String(s.num).padStart(3) + ' ' + (s.name||'').slice(0,32).padEnd(32) + ' · lag ' + (s.lag>=0?'+':'') + s.lag + '  →  ' + s.lagLabel));
const p71 = succ[71].length === 4 && succ[71].map(s=>s.num).sort((a,b)=>a-b).join(',') === '69,75,76,77';
allPass = allPass && p71;
console.log('   [' + ok(p71) + '] #71 has the expected 4 dependents (69,75,76,77)');

// 2) all three lag behaviors, labeled, from real Slab dependents
console.log('\nLag behavior labels — all three cases:');
const neg = succ[71].find(s => s.num === 69);   // -9
const zero = succ[71].find(s => s.num === 76);  // 0
const pos = (succ[101]||[]).find(s => s.num === 118); // +6 Landscaping
const cases = [
  ['negative (#71→#69, -9)', neg, 'Lead time · 9 days before this task starts'],
  ['zero (#71→#76, 0)',      zero, 'Right after this finishes'],
  ['positive (#101→#118, +6)', pos, '6 days after this finishes'],
];
cases.forEach(([label, s, want]) => {
  const good = s && s.lagLabel === want;
  allPass = allPass && good;
  console.log('   [' + ok(good) + '] ' + label + '  →  "' + (s?s.lagLabel:'MISSING') + '"');
});

// 3) orphan detection — deleting #71 orphans dependents that rely ONLY on it
console.log('\nfindOrphanedSuccessors(#71) — who would be orphaned if #71 is deleted:');
const orphans71 = Engine.findOrphanedSuccessors(tasks, 71);
orphans71.forEach(o => console.log('   #' + o.num + ' ' + (o.name||'').slice(0,30) + '  (preds ['+o.predecessors.join(',')+'])'));
const p71orphan = orphans71.length === 4;   // all four depend only on #71
allPass = allPass && p71orphan;
console.log('   [' + ok(p71orphan) + '] all 4 dependents orphaned (each depends only on #71)');

// 4) a multi-predecessor dependent is NOT orphaned when one pred is removed
// #54 Low Voltage Rough has predecessors [52,44]; deleting #52 leaves #44 -> not orphaned.
const orphans52 = Engine.findOrphanedSuccessors(tasks, 52);
const p54Safe = !orphans52.some(o => o.num === 54);
allPass = allPass && p54Safe;
console.log('\n   [' + ok(p54Safe) + '] deleting #52 does NOT orphan #54 (it still has predecessor #44)  ['+orphans52.length+' others orphaned]');

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
