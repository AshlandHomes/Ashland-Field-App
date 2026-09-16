'use strict';
const E = require('../schedule-engine.js');
const SE = (typeof E === 'function') ? E() : E;
const sd = new Date('2026-09-14T00:00:00');           // Monday = construction start (offset 1)
const at = (off) => SE.ymd(SE.offToDate(off, sd));

let pass=0, fail=0;
const eq = (name, got, want) => { const ok = got===want; ok?pass++:fail++; console.log((ok?'  ok  - ':'  FAIL- ')+name+'  (got '+got+', want '+want+')'); };

// ---- CHAIN: A(no pred, rs5, dur3) -> B(pred A, dur2) -> C(pred B, dur2) ----
function chain(estA, estB){ return [
  {num:1,name:'A',dur:3,lag:0,preds:[],  rs:5,rf:null,type:'work',order:1,est_start_date:estA||null,is_crit:false},
  {num:2,name:'B',dur:2,lag:0,preds:[1], rs:1,rf:null,type:'work',order:2,est_start_date:estB||null,is_crit:false},
  {num:3,name:'C',dur:2,lag:0,preds:[2], rs:1,rf:null,type:'work',order:3,est_start_date:null,is_crit:false}];}
const run = (estA,estB)=>{ const r=SE.computeFieldSchedule(chain(estA,estB),{},sd,'projected'); return {A:r.byNum[1].es,B:r.byNum[2].es,C:r.byNum[3].es,end:r.end}; };

const base = run(null,null);
console.log('CHAIN baseline: A'+base.A+' B'+base.B+' C'+base.C+' end'+base.end);
eq('baseline A at rs5', base.A, 5);
eq('baseline end', base.end, 11);

// THE FIX: no-predecessor task A, override EARLIER than rs -> lands + cascades earlier + completion earlier
const fixEarly = run(at(2), null);
eq('no-pred A override day2 lands (was floored to 5)', fixEarly.A, 2);
eq('  ...downstream B cascaded earlier', fixEarly.B, 5);   // A ef=4 -> B es5
eq('  ...completion moved earlier', fixEarly.end, 8);      // vs baseline 11

// no-pred A override LATER -> moves later + cascades later
const aLater = run(at(9), null);
eq('no-pred A override day9 later', aLater.A, 9);
eq('  ...completion moved later', aLater.end, 15);         // A ef11 -> B12/13 -> C14/15

// no-pred A override BELOW construction start -> clamped to offset 1
const aFloor = run('2026-09-09', null);                    // before the Monday start
eq('no-pred A override before construction start clamps to 1', aFloor.A, 1);

// PRED task B override EARLIER than its predecessor-earliest -> clamped (respects predecessor)
const bEarly = run(null, at(3));                           // pd_B = A.ef(7)+1 = 8; day3 < 8
eq('pred B override day3 clamped to predecessor-earliest 8', bEarly.B, 8);

// PRED task B override LATER -> drives later + cascades (backward-compat: max(pd,estOff))
const bLater = run(null, at(12));
eq('pred B override day12 later', bLater.B, 12);
eq('  ...C cascaded later', bLater.C, 14);
eq('  ...completion later', bLater.end, 15);

// ---- BACKWARD-COMPAT: pred task with no override identical to a hand CPM ----
eq('pred B baseline (max(pd) unchanged)', base.B, 8);
eq('pred C baseline unchanged', base.C, 10);

// ---- STANDALONE all-unchained branch: X,Y,Z no predecessors anywhere ----
function unchained(estY){ return [
  {num:1,name:'X',dur:2,lag:0,preds:[],rs:1,rf:null,type:'work',order:1,est_start_date:null,is_crit:false},
  {num:2,name:'Y',dur:2,lag:0,preds:[],rs:3,rf:null,type:'work',order:2,est_start_date:estY||null,is_crit:false},
  {num:3,name:'Z',dur:2,lag:0,preds:[],rs:5,rf:null,type:'work',order:3,est_start_date:null,is_crit:false}];}
const runU = (estY)=>{ const r=SE.computeFieldSchedule(unchained(estY),{},sd,'projected'); return {X:r.byNum[1].es,Y:r.byNum[2].es,Z:r.byNum[3].es}; };
const ub = runU(null);
eq('unchained baseline Y at rs3', ub.Y, 3);
eq('unchained Y override day1 (earlier) hard-sets (was floored to 3)', runU(at(1)).Y, 1);
eq('unchained Y override day7 (later)', runU(at(7)).Y, 7);

// ---- LEAD-TIME (negative lag) branch: override must WIN over backDriver (the BG52 task-33 bug) ----
// Pred(#1) at rs10; Order(#2) links to #1 with lag -6 => lead-time start = pred.start - 6.
function lead(estB){ return [
  {num:1,name:'Pred', dur:3,lag:0, preds:[], rs:10,rf:null,type:'work',order:1,est_start_date:null,is_crit:false},
  {num:2,name:'Order',dur:1,lag:-6,preds:[1],rs:1, rf:null,type:'work',order:2,est_start_date:estB||null,is_crit:false}];}
const runL = (estB)=>{ const r=SE.computeFieldSchedule(lead(estB),{},sd,'projected'); return {P:r.byNum[1].es, B:r.byNum[2].es}; };
eq('lead-time baseline: Order = pred.start(10) - 6 = 4 (backDriver, no override)', runL(null).B, 4);
eq('lead-time override day20 WINS over backDriver (was silently ignored — the bug)', runL(at(20)).B, 20);
eq('lead-time override day1 wins, clamped to construction start', runL(at(1)).B, 1);
eq('lead-time override leaves the predecessor unaffected', runL(at(20)).P, 10);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
