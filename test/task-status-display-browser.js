/*
 * Browser proof of the two field-app display fixes, driving the REAL
 * renderSchedule() inside ashland-stage-update-dev.html (no copies):
 *   FIX #1 — a started-but-not-finished task shows a PROJECTED finish
 *            (actual_start + duration, via the engine) labeled "(projected)",
 *            not "…".
 *   FIX #4 — an explicit STARTED / FINISHED tag on the task's name row.
 *
 * We seed a minimal lot whose #113 Low Voltage Trim is started (with a real
 * actual_start), plus a not-started control and a finished control, then read
 * back the DOM the page actually renders.
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const START = '2026-07-14';                 // construction start
const A_START_113 = '2026-08-07';           // #113 actually started here
const DUR_113 = 3;

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
  await page.waitForTimeout(150); errors.length = 0;   // drop offline-startup noise

  const out = await page.evaluate((cfg) => {
    const P = 'Interior Trim';
    // field-app task shape (post-mapping form)
    TASKS = [
      { _id:'t111', num:111, name:'Insulation', rs:1, dur:2, lag:0, rf:2, preds:[], phase:1, phase_name:P, type:'work', order:1, est_start_date:null, is_crit:false, note:'', flag:'none' },
      { _id:'t113', num:113, name:'Low Voltage Trim', rs:3, dur:cfg.dur, lag:0, rf:5, preds:[111], phase:1, phase_name:P, type:'work', order:2, est_start_date:null, is_crit:true, note:'', flag:'none' },
      { _id:'t114', num:114, name:'Interior Paint', rs:6, dur:3, lag:0, rf:8, preds:[113], phase:1, phase_name:P, type:'work', order:3, est_start_date:null, is_crit:false, note:'', flag:'none' },
    ];
    act = {
      111: { started:true, finished:true,  start:'2026-07-14', finish:'2026-07-15', vendor_confirmed:false },
      113: { started:true, finished:false, start:cfg.aStart,   finish:null,          vendor_confirmed:false },
      // 114 = not started
    };
    startDate = new Date(cfg.start + 'T00:00:00');
    curLot = { id:'lot-x', lot_number:'6', builder_name:'B', community:'RC',
               construction_start_date:cfg.start, status:'active', template_id:null,
               completion_stamped_at:null, scheduled_close_date:null };
    currentBuilder = 'B'; stageMap = []; lotGates = []; lotNotes = [];
    collapsedPhases = {}; userToggledPhases = true;   // keep phase expanded

    renderSchedule();

    const row = (n) => document.querySelector('.t .tnum')   // ensure rows exist
      ? Array.from(document.querySelectorAll('.t')).find(el => el.querySelector('.tnum') && el.querySelector('.tnum').textContent === '#'+n)
      : null;
    const pack = (n) => {
      const el = row(n); if(!el) return null;
      const st = el.querySelector('.tstatus');
      return {
        date: el.querySelector('.tdate').innerText.replace(/\s+/g,' ').trim(),
        dateHtml: el.querySelector('.tdate').innerHTML,
        hasProj: !!el.querySelector('.tdate .proj'),
        status: st ? st.textContent.trim() : null,
        statusClass: st ? st.className : null,
      };
    };
    // Independent expectation (NO engine): the finish is the dur-th working day
    // counting actual_start as day 1 — walk the calendar, skip Sat/Sun.
    let d = new Date(cfg.aStart + 'T00:00:00'), count = 1;
    while (count < cfg.dur) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) count++; }
    const expFinish = fmt(d);
    return { r111: pack(111), r113: pack(113), r114: pack(114), expFinish };
  }, { start: START, aStart: A_START_113, dur: DUR_113 });

  console.log('\n===== FIELD APP — task status display (real renderSchedule) =====\n');
  console.log('  #111 Insulation      status=' + JSON.stringify(out.r111.status) + '  date="' + out.r111.date + '"  proj=' + out.r111.hasProj);
  console.log('  #113 Low Voltage Trim status=' + JSON.stringify(out.r113.status) + '  date="' + out.r113.date + '"  proj=' + out.r113.hasProj);
  console.log('  #114 Interior Paint   status=' + JSON.stringify(out.r114.status) + '  date="' + out.r114.date + '"  proj=' + out.r114.hasProj);
  console.log('  (engine-independent expected #113 finish: ' + out.expFinish + ')');
  console.log('');

  check('no interaction errors ('+errors.length+')', errors.length === 0);
  // FIX #1
  check('#113 started shows a PROJECTED finish (not "…")', out.r113 && out.r113.hasProj && !/…/.test(out.r113.date));
  check('#113 projected finish = engine value ('+out.expFinish+')', out.r113 && out.r113.date.includes(out.expFinish) && out.r113.date.includes('(projected)'));
  check('#114 not-started finish is NOT labeled projected', out.r114 && !out.r114.hasProj && !/projected/.test(out.r114.date));
  check('#111 finished shows a committed finish (no "projected")', out.r111 && !out.r111.hasProj && !/projected/.test(out.r111.date));
  // FIX #4
  check('#113 shows STARTED tag', out.r113 && /^started$/i.test(out.r113.status||'') && /started/.test(out.r113.statusClass||''));
  check('#111 shows FINISHED tag', out.r111 && /^finished$/i.test(out.r111.status||'') && /done/.test(out.r111.statusClass||''));
  check('#114 not-started shows NO status tag', out.r114 && out.r114.status === null);

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : Rr+'FAIL') + Xx + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
