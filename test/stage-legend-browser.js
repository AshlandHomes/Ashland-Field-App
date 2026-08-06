/*
 * Browser proof of the expandable STAGE LEGEND in BOTH surfaces, driving the
 * REAL functions inside the real HTML files (no copies).
 *
 * The stage->task MAPPING lives in sched_stage_map_tasks (egress-blocked here),
 * so the fixture uses the two real Slab stages the owner supplied — stages 6 & 7
 * with their real driving-task bt_nums — and the task NAMES come straight from
 * the real template fixture (test/fixtures/template_tasks.json). Every name
 * rendered is therefore real Slab data.
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const tmpl = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/template_tasks.json'), 'utf8'));
const nameByBt = {}; tmpl.forEach(t => nameByBt[t.bt_num] = t.name);

// The two real Slab stages from the owner's spec.
const STAGES = [
  { code: '6', label: 'Trim & Cabinets Complete',                  order: 6, is_manual: false, triggers: [79, 84] },
  { code: '7', label: 'Mechanical Trim & Final Paint Complete',    order: 7, is_manual: false, triggers: [104, 108, 110, 95] },
];
const EXPECT = {
  '6': ['#79 Cabinets Installation', '#84 Trim & Interior Door Installation'],
  '7': ['#104 Plumbing Trim', '#108 HVAC Trim', '#110 Electrical Trim', '#95 Interior Paint - Final Coat'],
};

const G='\x1b[32m',Rr='\x1b[31m',Xx='\x1b[0m',ok=b=>b?G+'PASS'+Xx:Rr+'FAIL'+Xx;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const browser = await chromium.launch();

  // ── FIELD APP ──────────────────────────────────────────────────────────
  {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
      : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto('file://' + path.resolve(__dirname, '..', 'ashland-stage-update-dev.html'), { waitUntil: 'domcontentloaded' });
    // Ignore the page's own offline startup noise (loadBuilders' backend fetch has
    // no server here). We only care about errors the legend interaction itself throws.
    await page.waitForTimeout(150); errors.length = 0;

    const out = await page.evaluate((seed) => {
      // Seed the lexical globals the legend reads.
      stageMap = seed.stages;
      bn = {}; seed.tmpl.forEach(t => bn[t.bt_num] = { name: t.name });
      // Render the REAL legend function into a container and drive its toggles.
      const host = document.createElement('div'); host.id = 'test-host';
      host.innerHTML = stageLegendHtml(); document.body.appendChild(host);
      // Expand master, then expand every stage row.
      host.querySelector('button[onclick^="toggleStageLegendMaster"]').click();
      const masterOpen = host.querySelector('.slmbody').style.display !== 'none';
      const rowBtns = Array.from(host.querySelectorAll('button[onclick^="toggleStageRow"]'));
      const rowHeaders = rowBtns.map(b => b.innerText.replace(/\s+/g, ' ').trim());
      rowBtns.forEach(b => b.click());
      const bodies = Array.from(host.querySelectorAll('[id^="slrow-"]'))
        .map(d => ({ shown: d.style.display !== 'none', tasks: Array.from(d.children).map(c => c.textContent.trim()) }));
      return { masterOpen, rowHeaders, bodies };
    }, { stages: STAGES, tmpl });

    console.log('\n===== FIELD APP — Stage legend (real ashland-stage-update-dev.html) =====\n');
    console.log('master expanded:', out.masterOpen);
    out.rowHeaders.forEach((h, i) => {
      console.log('  ' + h);
      out.bodies[i].tasks.forEach(t => console.log('      ' + t));
    });
    console.log('');
    check('field: no page errors (' + errors.length + ')', errors.length === 0);
    check('field: master panel expands', out.masterOpen);
    check('field: two stage rows, ordered 6 then 7', out.rowHeaders.length === 2 && /\b6\b/.test(out.rowHeaders[0]) && /\b7\b/.test(out.rowHeaders[1]));
    check('field: stage 6 expands to its 2 real driving tasks', out.bodies[0].shown && JSON.stringify(out.bodies[0].tasks) === JSON.stringify(EXPECT['6']));
    check('field: stage 7 expands to its 4 real driving tasks', out.bodies[1].shown && JSON.stringify(out.bodies[1].tasks) === JSON.stringify(EXPECT['7']));
    await page.close();
  }

  // ── ADMIN ──────────────────────────────────────────────────────────────
  {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
      : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto('file://' + path.resolve(__dirname, '..', 'admin-dev.html'), { waitUntil: 'domcontentloaded' });

    const out = await page.evaluate(async (seed) => {
      const ltasks = seed.tmpl.map(t => ({ bt_num: t.bt_num, name: t.name }));
      // Override the network layer: openStageModal calls sbCall twice.
      sbCall = async (action) => {
        if (action === 'getTemplateStageMap') return { stages: seed.stages, gates: [] };
        if (action === 'getScheduleLotTasks') return { tasks: ltasks, gates: [] };
        return {};
      };
      loadSecret = async () => {};
      scheduleLots = [{ id: 'lot-slab', community: 'Slab', lot_number: 'T', template_id: 'tpl', reported_stage: '6', true_stage: null }];
      await openStageModal('lot-slab');
      const rows = Array.from(document.querySelectorAll('#stage-modal-body [onclick^="toggleAdminStageRow"]'));
      const headers = rows.map(r => r.innerText.replace(/\s+/g, ' ').trim());
      rows.forEach(r => r.click());
      const bodies = Array.from(document.querySelectorAll('#stage-modal-body [id^="astg-"]'))
        .map(d => ({ shown: d.style.display !== 'none', tasks: Array.from(d.children).map(c => c.textContent.trim()) }));
      return { headers, bodies };
    }, { stages: STAGES, tmpl });

    console.log('\n===== ADMIN — Stage legend modal (real admin-dev.html) =====\n');
    out.headers.forEach((h, i) => {
      console.log('  ' + h);
      out.bodies[i].tasks.forEach(t => console.log('      ' + t));
    });
    console.log('');
    check('admin: no page errors (' + errors.length + ')', errors.length === 0);
    check('admin: two stage rows, ordered 6 then 7', out.headers.length === 2 && /\b6\b/.test(out.headers[0]) && /\b7\b/.test(out.headers[1]));
    check('admin: stage 6 expands to its 2 real driving tasks', out.bodies[0].shown && JSON.stringify(out.bodies[0].tasks) === JSON.stringify(EXPECT['6']));
    check('admin: stage 7 expands to its 4 real driving tasks', out.bodies[1].shown && JSON.stringify(out.bodies[1].tasks) === JSON.stringify(EXPECT['7']));
    await page.close();
  }

  console.log('\n===== ' + (allPass ? G+'ALL PASS' : Rr+'FAIL') + Xx + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
