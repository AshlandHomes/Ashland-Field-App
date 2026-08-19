/*
 * Browser proof of the impossible-early est_start_date BLOCK, driving the REAL
 * saveEditTask() inside ashland-stage-update-dev.html (no copies).
 *
 * The rule: an est override may not be earlier than the task's predecessor-driven
 * earliest start (ScheduleEngine.earliestStart), which honors negative lag. Too
 * early => appModal block naming the binding predecessor + the engine's real
 * earliest date, and the task is NOT persisted. On-or-after => saves normally.
 *
 * Scenarios (construction start Tue 2026-07-14; all dates working-day-aware):
 *   Chain: #111 (dur2, es1 ef2) -> #112 [111] (dur2, es3 ef4) -> #113 [112]
 *   (offsets, Jul 18-19 is a weekend: 1=Jul14 2=Jul15 3=Jul16 4=Jul17 5=Jul20 6=Jul21)
 *   A. FORWARD lag 0 on #113  => earliest = ef[112]+1 = offset5 (Mon Jul 20).
 *      A1 too-early (Fri Jul 17, offset4) -> BLOCKED, names #112, earliest Jul 20, not saved.
 *      A2 after-earliest (Tue Jul 21)     -> SAVES, no modal.
 *   B. NEGATIVE lag -1 on #113 => earliest = es[112]-1 = offset2 (Jul 15).
 *      B1 at offset3 (Jul 16)   -> ALLOWED & SAVED even though it precedes #112's FINISH
 *                                  (offset4) — a naive finish-based check would wrongly block.
 *      B2 too-early (Jul 14, offset1) -> BLOCKED with the negative-lag "doesn't start until" copy.
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const START = '2026-07-14';   // Tue

const G='\x1b[32m',Rr='\x1b[31m',Xx='\x1b[0m',ok=b=>b?G+'PASS'+Xx:Rr+'FAIL'+Xx;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());   // never let a stray native alert/confirm hang
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
    : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '..', 'ashland-stage-update-dev.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;   // drop offline-startup noise

  const out = await page.evaluate(async (cfg) => {
    const P = 'Interior Trim';
    const seed = (lag113) => {
      TASKS = [
        { _id:'t111', num:111, name:'Insulation',        rs:1, dur:2, lag:0,     rf:2, preds:[],    phase:1, phase_name:P, type:'work', order:1, est_start_date:null, is_crit:false, note:'', flag:'none' },
        { _id:'t112', num:112, name:'Drywall',           rs:3, dur:2, lag:0,     rf:4, preds:[111], phase:1, phase_name:P, type:'work', order:2, est_start_date:null, is_crit:false, note:'', flag:'none' },
        { _id:'t113', num:113, name:'Low Voltage Trim',  rs:5, dur:2, lag:lag113,rf:6, preds:[112], phase:1, phase_name:P, type:'work', order:3, est_start_date:null, is_crit:false, note:'', flag:'none' },
      ];
      act = {};   // nothing started -> pure planned/projected chain
      startDate = new Date(cfg.start + 'T00:00:00');
      curLot = { id:'lot-x', lot_number:'6', builder_name:'B', community:'RC',
                 construction_start_date:cfg.start, status:'active', template_id:null,
                 completion_stamped_at:null, scheduled_close_date:null };
      currentBuilder='B'; stageMap=[]; lotGates=[]; lotNotes=[];
      collapsedPhases={}; userToggledPhases=true;
      bn={}; TASKS.forEach(t=>bn[t.num]=t);
      renderSchedule();   // populates _projected_es/_ef
    };

    // record every persistence call so we can assert save vs no-save
    const calls = [];
    sbCall = async (action, payload) => { calls.push({ action, payload }); return {}; };

    // Drive one edit: open #113, set est, call saveEditTask. Returns modal text (or null) + whether persisted.
    const runEdit = async (estYmd) => {
      calls.length = 0;
      openEditTask(113);
      const estEl = document.getElementById('edit-est-start');
      estEl.value = estYmd;                     // user typed an override
      const p = saveEditTask();                 // do NOT await yet — may block on appModal
      // let microtasks flush so a modal (if any) is in the DOM
      await new Promise(r => setTimeout(r, 0));
      const ov = document.getElementById('fm-overlay');
      let modalText = null;
      if (ov) {
        modalText = ov.querySelector('.dr-sub') ? ov.querySelector('.dr-sub').innerText.replace(/\s+/g,' ').trim() : '';
        ov.querySelector('.fm-btn').click();    // dismiss so the promise resolves
      }
      await p;                                   // now saveEditTask has fully returned
      const persisted = calls.some(c => c.action === 'updateScheduleLotTask');
      const savedEst = bn[113].est_start_date;
      // reset the field's task for the next scenario
      return { modalText, persisted, savedEst };
    };

    const results = {};

    // ── A. FORWARD lag 0 ──
    seed(0);
    results.projEs113_fwd = bn[113]._projected_es;   // expect offset 5 (Mon Jul 20)
    results.A1 = await runEdit('2026-07-17');        // offset 4 (Fri) — too early
    seed(0);
    results.A2 = await runEdit('2026-07-21');        // offset 6 (Tue) — after earliest, saves

    // ── B. NEGATIVE lag -1 ──
    seed(-1);
    results.projEs113_neg = bn[113]._projected_es;   // expect offset 2 (es[112]-1, Jul 15)
    results.B1 = await runEdit('2026-07-16');        // offset 3 — allowed, precedes #112 finish
    seed(-1);
    results.B2 = await runEdit('2026-07-14');        // offset 1 — too early

    return results;
  }, { start: START });

  console.log('\n===== FIELD APP — impossible-early est BLOCK (real saveEditTask) =====\n');
  console.log('  forward #113 projected es offset =', out.projEs113_fwd, '(expect 5, Mon Jul 20)');
  console.log('  neg-lag #113 projected es offset =', out.projEs113_neg, '(expect 2, Jul 15)');
  console.log('\n  A1 too-early (Fri Jul 17): persisted=' + out.A1.persisted + '  savedEst=' + JSON.stringify(out.A1.savedEst));
  console.log('      modal: ' + JSON.stringify(out.A1.modalText));
  console.log('  A2 after-earliest (Jul 21): persisted=' + out.A2.persisted + '  savedEst=' + JSON.stringify(out.A2.savedEst) + '  modal=' + JSON.stringify(out.A2.modalText));
  console.log('  B1 neg-lag (Jul 16):     persisted=' + out.B1.persisted + '  savedEst=' + JSON.stringify(out.B1.savedEst) + '  modal=' + JSON.stringify(out.B1.modalText));
  console.log('  B2 neg-lag too-early (Jul 14): persisted=' + out.B2.persisted + '  savedEst=' + JSON.stringify(out.B2.savedEst));
  console.log('      modal: ' + JSON.stringify(out.B2.modalText));
  console.log('');

  check('no interaction errors ('+errors.length+')', errors.length === 0);
  check('forward #113 earliest is offset 5 (Jul 21)', out.projEs113_fwd === 5);
  check('neg-lag #113 earliest is offset 2 (Jul 15)', out.projEs113_neg === 2);

  // A1 — blocked
  check('A1 too-early is BLOCKED (modal shown)', !!out.A1.modalText);
  check('A1 names the binding predecessor #112', /#112/.test(out.A1.modalText||''));
  check('A1 states the real earliest date (Jul 20, 2026)', /Jul 20, 2026/.test(out.A1.modalText||''));
  check('A1 forward copy says the predecessor does not FINISH until', /doesn.t finish until/i.test(out.A1.modalText||''));
  check('A1 offers the unlink path', /unlink #112/i.test(out.A1.modalText||''));
  check('A1 is NOT persisted', out.A1.persisted === false);
  check('A1 leaves est_start_date unchanged (null)', out.A1.savedEst === null);

  // A2 — allowed
  check('A2 on-earliest shows NO modal', !out.A2.modalText);
  check('A2 IS persisted', out.A2.persisted === true);
  check('A2 saved the override (2026-07-21)', out.A2.savedEst === '2026-07-21');

  // B1 — neg-lag allowed (the key regression guard): Jul 16 precedes #112's finish (Jul 17)
  check('B1 neg-lag before predecessor finish is ALLOWED (no modal)', !out.B1.modalText);
  check('B1 IS persisted (neg-lag not forced to finish+1)', out.B1.persisted === true);
  check('B1 saved the override (2026-07-16)', out.B1.savedEst === '2026-07-16');

  // B2 — neg-lag too-early, blocked with start-based copy
  check('B2 too-early is BLOCKED', !!out.B2.modalText);
  check('B2 uses the negative-lag "doesn\'t start until" copy', /doesn.t start until/i.test(out.B2.modalText||''));
  check('B2 states the lead time (leads it by 1 working day)', /leads it by 1 working day\b/.test(out.B2.modalText||''));
  check('B2 is NOT persisted', out.B2.persisted === false);

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : Rr+'FAIL') + Xx + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
