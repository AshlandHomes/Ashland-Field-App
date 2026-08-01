/*
 * test/wire-backend.js — proves the WIRED backend (netlify/functions/supabase.js)
 * produces correct output after its two inline engines were replaced by the shared
 * module. It exercises the exact adapters supabase.js now calls:
 *   recalcTemplateCriticalPath -> ScheduleEngine.computeTemplateCritical
 *   getAllLotPhases            -> ScheduleEngine.computeLotProjected
 *
 * Asserts, on real Slab template + Windermere Lot 1:
 *   A. template critical: wired == OLD-B (backend calcEF/calcLS) — is_critical set
 *      identical, 51 critical, project end 94.  (pure parity — OLD-B was correct)
 *   B. lot projected: wired == OLD-A (FIELD APP, source of truth) on every task —
 *      i.e. the admin now matches the builder app.  (the fix)
 *   C. lot projected: wired vs OLD-C (old backend computeProjected) — the 83 dates
 *      that were WRONG, now corrected. #51 and the below-floor/negative-lag tasks
 *      called out explicitly with old->new offset AND resulting date.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../schedule-engine.js');
const { oldFieldEngine, oldBackendTemplate, oldBackendProjected, addWD, ymd } = require('./old-engines');

const FIXTURE_DIR = process.env.FIXTURE_DIR || path.join(__dirname, 'fixtures');
const load = n => { const p = path.join(FIXTURE_DIR, n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : null; };
const G='\x1b[32m', R='\x1b[31m', X='\x1b[0m';
const ok = b => b ? G+'PASS'+X : R+'FAIL'+X;

const templateTasks = load('template_tasks.json');
const lotTasks = load('lot_tasks.json');
const lotMeta = load('lot.json');
if (!templateTasks || !lotTasks || !lotMeta) { console.error('Missing fixtures — run test/split-fixture.js.'); process.exit(2); }
const startISO = lotMeta.construction_start_date;
const startDate = new Date(startISO + 'T00:00:00');
let allPass = true;

console.log('\n' + '='.repeat(72));
console.log('WIRE-BACKEND — supabase.js wired to shared engine (real Slab + Lot 1)');
console.log('='.repeat(72));

// ── A. template critical: wired computeTemplateCritical == OLD-B ──
{
  const wired = Engine.computeTemplateCritical(templateTasks);          // what recalcTemplateCriticalPath now calls
  const B = oldBackendTemplate(templateTasks);                          // OLD-B verbatim
  let critDiff = 0;
  templateTasks.forEach(t => {
    const w = wired.updates.find(u => u.bt_num === t.bt_num);
    if (!!w.is_critical !== !!B.isCrit[t.bt_num]) critDiff++;
  });
  const pass = critDiff === 0 && wired.criticalCount === B.criticalCount && wired.projectEnd === B.projectEnd;
  allPass = allPass && pass;
  console.log('\nA. template critical writer  [' + ok(pass) + ']');
  console.log('   critical count: wired=' + wired.criticalCount + '  OLD-B=' + B.criticalCount + '   project end: wired=' + wired.projectEnd + '  OLD-B=' + B.projectEnd + '   is_critical diffs=' + critDiff);
}

// ── B & C. lot projected ──
{
  // wired: mutate copies (computeLotProjected writes _es/_projected_date in place)
  const wiredTasks = lotTasks.map(t => Object.assign({}, t));
  Engine.computeLotProjected(wiredTasks, startISO);
  const wiredEs = {}, wiredDate = {}; wiredTasks.forEach(t => { wiredEs[t.bt_num] = t._es; wiredDate[t.bt_num] = t._projected_date; });

  // OLD-A field app (source of truth)
  const fieldTasks = lotTasks.map(r => ({ num:r.bt_num, rs:r.relative_start, dur:r.duration, lag:(r.lag||0), rf:r.relative_finish,
    preds:r.predecessors||[], order:r.task_order, est_start_date:r.est_start_date||null, is_crit:!!r.is_critical,
    act:{ started:(r.status==='started'||r.status==='finished'), finished:(r.status==='finished'), start:r.actual_start, finish:r.actual_finish } }));
  const A = oldFieldEngine(fieldTasks, startDate, 'projected');

  // OLD-C old backend projected
  const C = oldBackendProjected(lotTasks, startISO);

  const keys = lotTasks.map(t => t.bt_num);
  const nameByNum = {}; lotTasks.forEach(t => nameByNum[t.bt_num] = t.name);

  // B: wired backend == field app on every task (the fix: admin now matches builder)
  const naDiff = keys.filter(k => wiredEs[k] !== A.es[k]);
  const passB = naDiff.length === 0;
  allPass = allPass && passB;
  console.log('\nB. lot projected: wired backend == field app (OLD-A)  [' + ok(passB) + ']');
  console.log('   ' + (passB ? 'identical on all ' + keys.length + ' tasks — admin and builder app now agree'
                              : naDiff.length + ' UNEXPECTED diffs: ' + naDiff.slice(0,10).map(k=>'#'+k+' wired='+wiredEs[k]+' field='+A.es[k]).join(', ')));

  // date sanity: projected_date present + equals addWD(start, es)
  let dateOk = true;
  keys.forEach(k => { const exp = ymd(addWD(startDate, wiredEs[k])); if (wiredDate[k] !== exp) dateOk = false; });
  console.log('   projected_date == addWD(start, es) for all tasks: [' + ok(dateOk) + ']');
  allPass = allPass && dateOk;

  // C: the corrected drift vs OLD-C
  const ncDiff = keys.filter(k => C.es[k] !== wiredEs[k]);
  console.log('\nC. lot projected: OLD-C (old admin) tasks now CORRECTED: ' + ncDiff.length + ' of ' + keys.length);
  const focus = [51, 72, 83, 86, 32, 58, 69];   // below-floor + notable negative-lag
  console.log('   spotlight (old admin es  →  wired es  →  projected date):');
  focus.forEach(k => {
    if (!nameByNum[k]) return;
    const t = lotTasks.find(x => x.bt_num === k);
    const tag = C.es[k] < 1 ? 'below-floor' : ((t.lag||0) < 0 ? 'neg-lag '+t.lag : 'cascade');
    console.log('     #' + String(k).padStart(3) + ' ' + (nameByNum[k]||'').slice(0,30).padEnd(30) + '  ' + String(C.es[k]).padStart(4) + '  →  ' + String(wiredEs[k]).padStart(3) + '  →  ' + wiredDate[k] + '   [' + tag + ']');
  });
  // explicit #51 assertion
  const k51 = wiredEs[51] === 1 && wiredDate[51] === ymd(addWD(startDate, 1));
  console.log('   #51 Order Flooring: old admin es=' + C.es[51] + ' (impossible) -> wired es=' + wiredEs[51] + ' date=' + wiredDate[51] + '  [' + ok(k51) + ']');
  allPass = allPass && k51;
}

console.log('\n' + '='.repeat(72));
console.log('WIRE-BACKEND OVERALL: ' + ok(allPass));
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
