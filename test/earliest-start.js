/*
 * test/earliest-start.js — proves ScheduleEngine.earliestStart on the real Slab
 * template. Core invariant: for EVERY task with a present predecessor, the
 * planned-mode engine start (es) IS the predecessor-driven earliest start, so
 * earliestStart(task, computed).offset must equal computed[task].es exactly —
 * across all lag signs (forward, zero, and negative lead-time). Plus explicit
 * binding-predecessor and negative-lag checks.
 */
'use strict';
const Engine = require('../schedule-engine.js');
const tasks = require('./fixtures/template_tasks.json');
const byNum = {}; tasks.forEach(t => byNum[t.bt_num] = t);

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

// planned schedule → { num: {es, ef} }
const planned = Engine.computeSchedule(tasks.map(t => ({
  num: t.bt_num, duration: t.duration, lag: t.lag, predecessors: t.predecessors,
  relativeStart: t.relative_start
})), { mode: 'planned' });
const computed = {}; planned.tasks.forEach(r => computed[r.num] = { es: r.es, ef: r.ef });

console.log('\n===== earliestStart — real Slab template =====\n');

// 1) INVARIANT: earliestStart.offset === engine es, for every task with a present predecessor.
let checked = 0, mismatches = [];
tasks.forEach(t => {
  const preds = (t.predecessors || []).filter(p => computed[p]);
  if (!preds.length) return;                       // roots have no predecessor driver
  const es = Engine.earliestStart({ num: t.bt_num, predecessors: t.predecessors, lag: t.lag }, computed);
  checked++;
  if (!es || es.offset !== computed[t.bt_num].es) {
    mismatches.push('#' + t.bt_num + ' earliestStart=' + (es && es.offset) + ' vs engine es=' + computed[t.bt_num].es + ' (lag ' + t.lag + ')');
  }
});
console.log('   invariant checked on ' + checked + ' tasks with predecessors');
check('earliestStart.offset === engine es for ALL of them (all lag signs)', mismatches.length === 0);
if (mismatches.length) mismatches.slice(0, 8).forEach(m => console.log('       ' + m));

// 2) Forward, zero lag: #4 Clearing preds [2] lag 0 → binds #2, offset = ef[2]+1.
{
  const es = Engine.earliestStart({ num: 4, predecessors: [2], lag: 0 }, computed);
  check('#4 (lag 0, pred [2]) binds #2, offset = ef[2]+1',
    es && es.bindingPred === 2 && es.offset === computed[2].ef + 1);
}

// 3) Multi-predecessor: #54 Low Voltage Rough preds [52,44] lag 0 → binds the later-finishing one.
{
  const es = Engine.earliestStart({ num: 54, predecessors: [52, 44], lag: 0 }, computed);
  const laterPred = computed[52].ef >= computed[44].ef ? 52 : 44;
  check('#54 (preds [52,44]) binds the later-finishing predecessor (#' + laterPred + ')',
    es && es.bindingPred === laterPred && es.offset === computed[laterPred].ef + 1);
}

// 4) NEGATIVE LAG (lead time): #69 Drywall Delivery preds [71] lag -9.
//    Must be es[71] - 9 (BEFORE #71 starts), NOT ef[71] + 1. Confirms neg-lag is honored.
{
  const es = Engine.earliestStart({ num: 69, predecessors: [71], lag: -9 }, computed);
  const wrongForwardValue = computed[71].ef + 1 + (-9);
  check('#69 (lag -9) uses pred START (es[71]-9), binds #71',
    es && es.bindingPred === 71 && es.offset === Math.max(1, computed[71].es - 9));
  check('#69 is NOT computed as predecessor-finish + 1 (neg-lag not forced late)',
    es && es.offset !== wrongForwardValue);
  console.log('       #69: es[71]=' + computed[71].es + ' ef[71]=' + computed[71].ef +
    '  → earliestStart=' + es.offset + '  (forward-would-be=' + wrongForwardValue + ')');
}

// 5) No predecessor → null (roots like #2 Silt Fence).
{
  const es = Engine.earliestStart({ num: 2, predecessors: [], lag: 0 }, computed);
  check('#2 Silt Fence (no predecessor) → null', es === null);
}

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
