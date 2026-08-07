/*
 * Browser proof of the finish-flow branches (#3), driving the REAL finishTask()
 * inside ashland-stage-update-dev.html (no copies). We stub only the interactive
 * shells (confirm / alert / openDatePicker / openDelayReasonModal) and sbCall,
 * then assert, per branch:
 *   - which prompt fired (from projected finish vs today),
 *   - the finish date actually saved (via saveTask -> updateScheduleLotTask),
 *   - whether a delay reason was captured — required IFF actual > projected,
 *     with expected_done === the projected finish.
 *
 * Branches: ON-TIME, EARLY, LATE(date ≤ projected → no reason),
 * LATE(date > projected → reason), FUTURE-attempt (blocked, no save).
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const G='\x1b[32m',Rr='\x1b[31m',Xx='\x1b[0m',ok=b=>b?G+'PASS'+Xx:Rr+'FAIL'+Xx;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
    : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '..', 'ashland-stage-update-dev.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;

  const runScenario = (opts) => page.evaluate(async (o) => {
    const iso = (offDays) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + offDays);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
    const today = iso(0), cs = iso(-120);

    // ── seed a real-shaped network (tasks HAVE predecessors, so the engine uses
    // its CPM branch and computes _crit from pure FLOAT — exactly like production,
    // where is_critical is ignored for the field _crit set; see KI-1).
    //   #100 anchor (finished) -> #113 (task under test)
    //   when o.sibling: #100 -> #200 long pole (20 WD) so #113 gains float and
    //   the engine computes it NON-critical (_crit=false); without it #113 is on
    //   the longest path -> critical (_crit=true). We assert the COMPUTED _crit.
    const P = 'Trim';
    TASKS = [
      { _id:'t100', num:100, name:'Anchor', rs:1, dur:1, lag:0, rf:1, preds:[], phase:1, phase_name:P, type:'work', order:1, est_start_date:null, is_crit:true, note:'', flag:'none' },
      { _id:'t113', num:113, name:'Low Voltage Trim', rs:2, dur:o.dur, lag:0, rf:o.dur+1, preds:[100], phase:1, phase_name:P, type:'work', order:2, est_start_date:null, is_crit:true, note:'', flag:'none' },
    ];
    if (o.sibling) TASKS.push({ _id:'t200', num:200, name:'Long Pole', rs:2, dur:20, lag:0, rf:21, preds:[100], phase:1, phase_name:P, type:'work', order:3, est_start_date:null, is_crit:true, note:'', flag:'none' });
    bn = {}; TASKS.forEach(x => bn[x.num] = x);        // openLot normally builds this
    // #100 finished (so #113's predecessor soft-warning never fires); #113 started.
    act = { 100: { started:true, finished:true, start:cs, finish:cs, vendor_confirmed:false },
            113: { started:true, finished:false, start:o.aStart, finish:null, vendor_confirmed:false } };
    startDate = new Date(cs + 'T00:00:00');
    curLot = { id:'lot-x', lot_number:'6', builder_name:'B', community:'RC', construction_start_date:cs,
               status:'active', template_id:null, completion_stamped_at:null, scheduled_close_date:null };
    currentBuilder = 'B'; stageMap = []; lotGates = []; lotNotes = [];
    collapsedPhases = {}; userToggledPhases = true; _drReasons = null;
    renderSchedule();                                  // engine sets _projected_ef
    const t = bn[113];
    const projYmd = ymd(offToDate(t._projected_ef));

    // ── capture + stubs ──
    const cap = { confirm:[], alert:[], picker:[], delayArgs:null, delayCalled:false, sb:[] };
    window.confirm = (m) => { cap.confirm.push(m); return o.confirmReturn !== false; };
    window.alert   = (m) => { cap.alert.push(m); };
    openDatePicker = async (title) => { cap.picker.push(title); return (o.pickerReturn === undefined ? null : o.pickerReturn); };
    openDelayReasonModal = async (bt, name, ref, actual, late) => { cap.delayCalled = true; cap.delayArgs = { ref, actual, late }; return { id:'r1', label:'Weather', note:'' }; };
    sbCall = async (action, payload) => { cap.sb.push({ action, payload }); if (action === 'getDelayReasons') return [{ id:'r1', label:'Weather' }]; return {}; };

    await finishTask(113);

    const finWrite = cap.sb.find(c => c.action === 'updateScheduleLotTask' && c.payload && c.payload.status === 'finished');
    const delayWrite = cap.sb.find(c => c.action === 'addTaskDelay');
    return { today, projYmd, crit: t._crit === true, cap: { confirm:cap.confirm, alert:cap.alert, pickerCount:cap.picker.length, delayCalled:cap.delayCalled, delayArgs:cap.delayArgs },
             savedFinish: finWrite ? finWrite.payload.actual_finish : null,
             delayWrite: delayWrite ? delayWrite.payload : null };
  }, opts);

  const join = a => a.join(' | ');
  console.log('\n===== FINISH-FLOW BRANCHES (real finishTask, field app) =====');

  const ON = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });
  // 1) ON-TIME — projected finish == today (weekday). dur 1, started today.
  {
    const r = await runScenario({ aStart: ON, dur: 1, crit: true, confirmReturn: true });
    console.log('\n[ON-TIME]  proj=' + r.projYmd + ' today=' + r.today);
    console.log('  confirm: ' + join(r.cap.confirm) + '  | saved=' + r.savedFinish + '  delay=' + r.cap.delayCalled);
    check('on-time: projected finish equals today', r.projYmd === r.today);
    check('on-time: a "projected date" confirm fired (no picker, no alert)', /projected date/i.test(join(r.cap.confirm)) && r.cap.pickerCount === 0 && r.cap.alert.length === 0);
    check('on-time: saved finish = today', r.savedFinish === r.today);
    check('on-time: NO delay reason', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // 2) EARLY — projected finish in the future. dur 10, started today.
  {
    const r = await runScenario({ aStart: ON, dur: 10, crit: true, confirmReturn: true });
    console.log('\n[EARLY]  proj=' + r.projYmd + ' today=' + r.today);
    console.log('  confirm: ' + join(r.cap.confirm) + '  | saved=' + r.savedFinish + '  delay=' + r.cap.delayCalled);
    check('early: projected finish is in the future', r.projYmd > r.today);
    check('early: an "early" statement confirm fired (no picker)', /early/i.test(join(r.cap.confirm)) && r.cap.pickerCount === 0);
    check('early: saved finish = today', r.savedFinish === r.today);
    check('early: NO delay reason', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // Past start (15 days ago), dur 1 → projected finish in the past → LATE branch.
  const PAST = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-15); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });

  // 3) LATE, entered date ON/BEFORE projected → NO reason.
  {
    const probe = await runScenario({ aStart: PAST, dur: 1, crit: true, pickerReturn: '__PROBE__' }); // first get projYmd
    const r = await runScenario({ aStart: PAST, dur: 1, crit: true, pickerReturn: probe.projYmd });   // picker returns projected date itself
    console.log('\n[LATE ≤ projected]  proj=' + r.projYmd + ' today=' + r.today + '  entered=' + r.projYmd);
    console.log('  alert: ' + join(r.cap.alert) + '  | picker=' + r.cap.pickerCount + '  saved=' + r.savedFinish + '  delay=' + r.cap.delayCalled);
    check('late: projected finish already passed', r.projYmd < r.today);
    check('late: "past its projected finish" alert + date picker fired', /past its projected finish/i.test(join(r.cap.alert)) && r.cap.pickerCount === 1);
    check('late ≤ projected: saved finish = entered date', r.savedFinish === r.projYmd);
    check('late ≤ projected: NO delay reason (was not actually late)', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // 4) CRITICAL, LATE, entered date AFTER projected (today) → reason REQUIRED.
  {
    const r = await runScenario({ aStart: PAST, dur: 1, pickerReturn: ON });  // #113 alone → critical; entered=today > projected
    console.log('\n[CRITICAL, LATE > projected]  crit=' + r.crit + ' proj=' + r.projYmd + ' today=' + r.today + '  entered=' + r.today);
    console.log('  delayCalled=' + r.cap.delayCalled + '  delayWrite=' + JSON.stringify(r.delayWrite) + '  saved=' + r.savedFinish);
    check('critical-late: task is on the computed critical path (_crit=true)', r.crit === true);
    check('critical-late: delay reason modal fired', r.cap.delayCalled === true);
    check('critical-late: saved finish = entered date (today)', r.savedFinish === r.today);
    check('critical-late: addTaskDelay expected_done === projected finish', r.delayWrite && r.delayWrite.expected_done === r.projYmd);
    check('critical-late: addTaskDelay actual_finish === entered date', r.delayWrite && r.delayWrite.actual_finish === r.today);
  }

  // 4b) NON-CRITICAL, LATE past projected (today) → NO reason (has float).
  {
    const r = await runScenario({ aStart: PAST, dur: 1, sibling: true, pickerReturn: ON });  // long-pole sibling → #113 has float
    console.log('\n[NON-CRITICAL, LATE > projected]  crit=' + r.crit + ' proj=' + r.projYmd + ' today=' + r.today + '  entered=' + r.today);
    console.log('  delayCalled=' + r.cap.delayCalled + '  saved=' + r.savedFinish);
    check('non-critical-late: task is NOT on the critical path (_crit=false)', r.crit === false);
    check('non-critical-late: finished past projected finish', r.today > r.projYmd);
    check('non-critical-late: NO delay reason (float absorbs it)', r.cap.delayCalled === false && r.delayWrite === null);
    check('non-critical-late: still saved (finish = entered date)', r.savedFinish === r.today);
  }

  // 5) FUTURE attempt via the late picker → BLOCKED, nothing saved.
  {
    const FUT = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+3); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });
    const r = await runScenario({ aStart: PAST, dur: 1, crit: true, pickerReturn: FUT });
    console.log('\n[FUTURE attempt]  entered=' + FUT + '  today=' + r.today);
    console.log('  alert: ' + join(r.cap.alert) + '  | saved=' + r.savedFinish);
    check('future: blocked with the "not allowed ... future date" rule message', /not allowed to complete a task on a future date/i.test(join(r.cap.alert)));
    check('future: NOTHING saved (no finish write)', r.savedFinish === null);
    check('future: NO delay reason', r.cap.delayCalled === false);
  }

  console.log('');
  check('no interaction errors ('+errors.length+')', errors.length === 0);
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : Rr+'FAIL') + Xx + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
