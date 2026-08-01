/*
 * test/wire-field.js — proves the WIRED field app (ashland-stage-update-dev.html)
 * still produces identical schedule output after runEngine was replaced by a call
 * to the shared engine. It reconstructs the field app's exact openLot() data
 * mapping, runs the NEW wired path (ScheduleEngine.computeFieldSchedule + the
 * write-back loop, mirroring the new runEngine), and asserts the resulting
 * _{mode}_es/_ef/_crit match OLD-A (the pre-wiring field engine) on every task.
 *
 * Runs against the real Windermere Lot 1 fixture; falls back to nothing if absent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../schedule-engine.js');
const { oldFieldEngine } = require('./old-engines');

const FIXTURE_DIR = process.env.FIXTURE_DIR || path.join(__dirname, 'fixtures');
function loadJSON(n){ const p = path.join(FIXTURE_DIR, n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : null; }
function ok(b){ return b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'; }

const lotMeta = loadJSON('lot.json');
const rows = loadJSON('lot_tasks.json');
if (!lotMeta || !rows) { console.error('No real lot fixture (lot.json / lot_tasks.json) — run test/split-fixture.js first.'); process.exit(2); }

const startDate = new Date(lotMeta.construction_start_date + 'T00:00:00');

// ── EXACT reconstruction of the field app's openLot() mapping ──
// TASKS: ashland-stage-update-dev.html openLot()  |  act: same
const TASKS = rows.map(r => ({
  _id:r.id, num:r.bt_num, name:r.name, rs:r.relative_start, dur:r.duration, lag:r.lag,
  rf:r.relative_finish, preds:r.predecessors||[], phase:r.phase_order, phase_name:r.phase_name,
  type:r.task_type, order:r.task_order, note:r.note||'', flag:r.flag||'none',
  est_start_date:r.est_start_date||null, is_crit:!!r.is_critical
}));
const bn = {}; TASKS.forEach(t => bn[t.num] = t);
const act = {}; rows.forEach(r => { act[r.bt_num] = {
  started:(r.status==='started'||r.status==='finished'), finished:(r.status==='finished'),
  start:r.actual_start, finish:r.actual_finish, vendor_confirmed:!!r.vendor_confirmed
}; });

// ── the NEW wired runEngine (verbatim behavior of the HTML's new runEngine) ──
function runEngine(mode){
  const r = Engine.computeFieldSchedule(TASKS, act, startDate, mode);
  TASKS.forEach(t => { const x=r.byNum[t.num]; if(!x) return; t['_'+mode+'_es']=x.es; t['_'+mode+'_ef']=x.ef; if(mode==='planned') t._crit=x.critical; });
  return r.end;
}

// ── OLD-A reference: field-shaped tasks with actuals embedded ──
const oldTasks = rows.map(r => ({
  num:r.bt_num, rs:r.relative_start, dur:r.duration, lag:(r.lag||0), rf:r.relative_finish,
  preds:r.predecessors||[], order:r.task_order, est_start_date:r.est_start_date||null, is_crit:!!r.is_critical,
  act:{ started:(r.status==='started'||r.status==='finished'), finished:(r.status==='finished'), start:r.actual_start, finish:r.actual_finish }
}));

let allPass = true;
console.log('\n' + '='.repeat(72));
console.log('WIRE-FIELD — wired field app runEngine vs OLD-A, real lot ' + (lotMeta.lot_number||lotMeta.id) + ' (start ' + lotMeta.construction_start_date + ')');
console.log('='.repeat(72));

['planned','projected'].forEach(mode => {
  const endNew = runEngine(mode);                         // writes _{mode}_es/_ef/_crit onto TASKS
  const A = oldFieldEngine(oldTasks, startDate, mode);
  let esDiff=0, efDiff=0, critDiff=0;
  const samples = [];
  TASKS.forEach(t => {
    if (t['_'+mode+'_es'] !== A.es[t.num]) { esDiff++; if(samples.length<10) samples.push('es #'+t.num+' new='+t['_'+mode+'_es']+' old='+A.es[t.num]); }
    if (t['_'+mode+'_ef'] !== A.ef[t.num]) { efDiff++; if(samples.length<10) samples.push('ef #'+t.num+' new='+t['_'+mode+'_ef']+' old='+A.ef[t.num]); }
    if (mode==='planned' && (!!t._crit !== !!A.crit[t.num])) { critDiff++; if(samples.length<10) samples.push('crit #'+t.num+' new='+t._crit+' old='+A.crit[t.num]); }
  });
  const endOld = A.end;
  const pass = esDiff===0 && efDiff===0 && critDiff===0 && endNew===endOld;
  allPass = allPass && pass;
  const critN = mode==='planned' ? ('  critical: '+TASKS.filter(t=>t._crit).length) : '';
  console.log('  ['+ok(pass)+'] '+mode.padEnd(9)+' end new='+endNew+' old='+endOld+'  es-diffs='+esDiff+' ef-diffs='+efDiff+(mode==='planned'?' crit-diffs='+critDiff:'')+critN);
  if (!pass) samples.forEach(s => console.log('        '+s));
});

console.log('='.repeat(72));
console.log('WIRE-FIELD OVERALL: ' + ok(allPass) + '  (all ' + TASKS.length + ' tasks, planned + projected)');
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
