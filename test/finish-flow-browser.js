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
    // window.confirm/alert must NEVER be called (FIX 1: fully in-app). We record
    // them to assert zero. appModal is the in-app modal — scripted per modal type.
    const cap = { confirm:[], alert:[], modals:[], picker:[], blocked:null, delayArgs:null, delayCalled:false, sb:[] };
    window.confirm = (m) => { cap.confirm.push(m); return true; };
    window.alert   = (m) => { cap.alert.push(m); };
    appModal = async ({ title, sub, buttons }) => {
      cap.modals.push({ title, values: (buttons||[]).map(b => b.value) });
      if (/Unfinished predecessors/.test(title)) return (o.predChoice === undefined ? 'go' : o.predChoice);
      if (/^Finish /.test(title)) return o.modalChoice;                 // 'today' | 'proj' | 'pick' | null
      cap.blocked = { title, sub };                                     // future / invalid / not-allowed info modal (single OK)
      return null;
    };
    openDatePicker = async (title) => { cap.picker.push(title); return (o.pickerReturn === undefined ? null : o.pickerReturn); };
    openDelayReasonModal = async (bt, name, ref, actual, late) => { cap.delayCalled = true; cap.delayArgs = { ref, actual, late }; return { id:'r1', label:'Weather', note:'' }; };
    sbCall = async (action, payload) => { cap.sb.push({ action, payload }); if (action === 'getDelayReasons') return [{ id:'r1', label:'Weather' }]; return {}; };

    await finishTask(113);

    const finWrite = cap.sb.find(c => c.action === 'updateScheduleLotTask' && c.payload && c.payload.status === 'finished');
    const delayWrite = cap.sb.find(c => c.action === 'addTaskDelay');
    return { today, projYmd, crit: t._crit === true,
             cap: { confirmCount:cap.confirm.length, alertCount:cap.alert.length, modals:cap.modals,
                    pickerCount:cap.picker.length, blocked:cap.blocked, delayCalled:cap.delayCalled, delayArgs:cap.delayArgs },
             savedFinish: finWrite ? finWrite.payload.actual_finish : null,
             delayWrite: delayWrite ? delayWrite.payload : null };
  }, opts);

  const titles = r => r.cap.modals.map(m => m.title).join(' | ');
  const noNativePopups = r => r.cap.confirmCount === 0 && r.cap.alertCount === 0;
  console.log('\n===== FINISH-FLOW (real finishTask + in-app modals, field app) =====');

  const ON = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });
  // 1) ON-TIME — projected finish == today (weekday). dur 1, started today.
  {
    const r = await runScenario({ aStart: ON, dur: 1, modalChoice: 'today' });
    console.log('\n[ON-TIME]  proj=' + r.projYmd + ' today=' + r.today + '  modal="' + titles(r) + '"  saved=' + r.savedFinish);
    check('on-time: projected finish equals today', r.projYmd === r.today);
    check('on-time: in-app Finish modal shown, no picker', /^Finish /.test(titles(r)) && r.cap.pickerCount === 0);
    check('on-time: NO browser confirm/alert', noNativePopups(r));
    check('on-time: saved finish = today', r.savedFinish === r.today);
    check('on-time: NO delay reason', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // 2) EARLY — projected finish in the future. dur 10, started today.
  {
    const r = await runScenario({ aStart: ON, dur: 10, modalChoice: 'today' });
    console.log('\n[EARLY]  proj=' + r.projYmd + ' today=' + r.today + '  modal="' + titles(r) + '"  saved=' + r.savedFinish);
    check('early: projected finish is in the future', r.projYmd > r.today);
    check('early: in-app Finish modal shown, no picker', /^Finish /.test(titles(r)) && r.cap.pickerCount === 0);
    check('early: NO browser confirm/alert', noNativePopups(r));
    check('early: saved finish = today', r.savedFinish === r.today);
    check('early: NO delay reason', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // Past start (15 days ago), dur 1 → projected finish in the past → LATE state.
  const PAST = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-15); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });
  const projProbe = await runScenario({ aStart: PAST, dur: 1, modalChoice: null });   // read projYmd (cancel out)
  const PROJ = projProbe.projYmd;

  // 3) LATE → [Backdate to projected date] → finish = projected, NO reason (even though critical).
  {
    const r = await runScenario({ aStart: PAST, dur: 1, modalChoice: 'proj' });
    console.log('\n[LATE → Backdate to projected]  crit=' + r.crit + ' proj=' + r.projYmd + ' today=' + r.today + '  saved=' + r.savedFinish);
    check('late: projected finish already passed', r.projYmd < r.today);
    check('late: 3-choice modal shown (proj/today/pick/cancel)', r.cap.modals.some(m => m.values.includes('proj') && m.values.includes('today') && m.values.includes('pick')));
    check('backdate: NO picker opened (one tap)', r.cap.pickerCount === 0);
    check('backdate: saved finish = projected date', r.savedFinish === r.projYmd);
    check('backdate: NO delay reason (finished on time, just recorded late)', r.cap.delayCalled === false && r.delayWrite === null);
    check('backdate: NO browser confirm/alert', noNativePopups(r));
  }

  // 4) LATE → [Finished today], CRITICAL → reason REQUIRED.
  {
    const r = await runScenario({ aStart: PAST, dur: 1, modalChoice: 'today' });   // #113 alone → critical
    console.log('\n[LATE → Finished today, CRITICAL]  crit=' + r.crit + ' proj=' + r.projYmd + ' saved=' + r.savedFinish + '  delay=' + r.cap.delayCalled);
    check('finished-today: task is on the computed critical path (_crit=true)', r.crit === true);
    check('finished-today: NO picker opened (one tap)', r.cap.pickerCount === 0);
    check('finished-today critical: delay reason modal fired', r.cap.delayCalled === true);
    check('finished-today critical: saved finish = today', r.savedFinish === r.today);
    check('finished-today critical: addTaskDelay expected_done === projected finish', r.delayWrite && r.delayWrite.expected_done === r.projYmd);
    check('finished-today critical: addTaskDelay actual_finish === today', r.delayWrite && r.delayWrite.actual_finish === r.today);
  }

  // 4b) LATE → [Finished today], NON-CRITICAL → NO reason (float absorbs it).
  {
    const r = await runScenario({ aStart: PAST, dur: 1, sibling: true, modalChoice: 'today' });   // long-pole sibling → float
    console.log('\n[LATE → Finished today, NON-CRITICAL]  crit=' + r.crit + ' proj=' + r.projYmd + ' saved=' + r.savedFinish + '  delay=' + r.cap.delayCalled);
    check('non-critical: NOT on the critical path (_crit=false)', r.crit === false);
    check('non-critical: finished past projected finish', r.today > r.projYmd);
    check('non-critical: NO delay reason (float absorbs it)', r.cap.delayCalled === false && r.delayWrite === null);
    check('non-critical: still saved (finish = today)', r.savedFinish === r.today);
  }

  // 5) LATE → [Different date…] → date AFTER projected (today) → reason REQUIRED.
  {
    const r = await runScenario({ aStart: PAST, dur: 1, modalChoice: 'pick', pickerReturn: ON });
    console.log('\n[LATE → Different date > projected]  proj=' + r.projYmd + ' entered=' + r.today + '  picker=' + r.cap.pickerCount + ' delay=' + r.cap.delayCalled);
    check('different-date: opened the date picker', r.cap.pickerCount === 1);
    check('different-date > projected: delay reason captured', r.cap.delayCalled === true && r.delayWrite && r.delayWrite.actual_finish === r.today);
    check('different-date > projected: saved finish = entered date', r.savedFinish === r.today);
  }

  // 5b) LATE → [Different date…] → date ON/BEFORE projected → NO reason.
  {
    const r = await runScenario({ aStart: PAST, dur: 1, modalChoice: 'pick', pickerReturn: PROJ });
    console.log('\n[LATE → Different date ≤ projected]  proj=' + r.projYmd + ' entered=' + PROJ + '  delay=' + r.cap.delayCalled);
    check('different-date ≤ projected: opened picker, saved entered date', r.cap.pickerCount === 1 && r.savedFinish === PROJ);
    check('different-date ≤ projected: NO delay reason', r.cap.delayCalled === false && r.delayWrite === null);
  }

  // 6) FUTURE attempt via [Different date…] → BLOCKED in-app, nothing saved.
  {
    const FUT = await page.evaluate(() => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+3); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); });
    const r = await runScenario({ aStart: PAST, dur: 1, modalChoice: 'pick', pickerReturn: FUT });
    console.log('\n[FUTURE attempt]  entered=' + FUT + '  today=' + r.today + '  blocked=' + JSON.stringify(r.cap.blocked));
    check('future: blocked by an IN-APP modal with the rule message', !!r.cap.blocked && /can't complete a task on a future date/i.test(r.cap.blocked.sub));
    check('future: NO browser confirm/alert', noNativePopups(r));
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
