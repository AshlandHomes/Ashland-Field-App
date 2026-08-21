/*
 * Browser proof that the REAL admin renderLotsTable() (admin-dev.html) renders
 * the completion column from engine-computed lotPhases dates (KI-2 fix) — the
 * projected date (== field app) as primary, the planned baseline as secondary —
 * and that it re-renders LIVE when lotPhases refreshes (the reloadLots path),
 * i.e. the completion is no longer frozen.
 *
 * We seed scheduleLots + lotPhases exactly as the real loaders produce them,
 * stub the unrelated cell helpers, and drive the real renderLotsTable().
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const LOT_ID = 'lot-parity';
const PROJ_1 = '2026-11-20';      // engine projected completion (matches parity proof)
const BASE_1 = '2026-11-20';      // engine planned baseline
const PROJ_2 = '2026-12-04';      // projected AFTER an est push (moves later)

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
    : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '..', 'admin-dev.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;

  const out = await page.evaluate((cfg) => {
    const lot = { id: cfg.LOT_ID, lot_number: '12', community: 'RC', address: null,
      builder_name: 'B', status: 'active', reported_stage: '3', true_stage: null,
      construction_start_date: '2026-07-14', scheduled_close_date: null,
      completion_stamped_at: null, last_task_update: null };
    scheduleLots = [lot];
    // isolate the completion cell: stub unrelated helpers + bypass filters
    getFilteredLots = () => scheduleLots;
    subBadge = () => ''; stageCell = () => ''; phaseCell = () => '';
    closeBadgeHtml = () => ''; staleCell = () => ''; isUpdatedRecently = () => false;
    flaggedNotesByLot = {};

    const cellText = () => {
      const row = document.querySelector('#lots-table-body tbody tr');
      // completion is the 7th column (Sub,Lot,Builder,Stage,Phase,Start,Completion)
      return row ? row.children[6].innerText.replace(/\s+/g, ' ').trim() : null;
    };

    // 1) engine dates present in lotPhases (as getAllLotPhases returns them)
    lotPhases = { [cfg.LOT_ID]: { projEndDate: cfg.PROJ_1, planEndDate: cfg.BASE_1 } };
    renderLotsTable();
    const first = cellText();

    // 2) lotPhases refreshes (est pushed out) -> re-render -> cell MOVES
    lotPhases = { [cfg.LOT_ID]: { projEndDate: cfg.PROJ_2, planEndDate: cfg.BASE_1 } };
    renderLotsTable();
    const afterEst = cellText();

    // 3) non-active lot with no lotPhases entry -> em dash, no fabricated date
    lotPhases = {};
    renderLotsTable();
    const noData = cellText();

    return { first, afterEst, noData };
  }, { LOT_ID, PROJ_1, BASE_1, PROJ_2 });

  const D = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'});

  console.log('\n===== ADMIN — completion column renders engine lotPhases dates =====\n');
  console.log('   initial cell : ' + JSON.stringify(out.first));
  console.log('   after est push: ' + JSON.stringify(out.afterEst));
  console.log('   no lotPhases : ' + JSON.stringify(out.noData));
  console.log('');

  check('no render errors (' + errors.length + ')', errors.length === 0);
  check('cell shows the engine PROJECTED date (' + D(PROJ_1) + ') labeled proj',
    !!out.first && out.first.includes(D(PROJ_1)) && /proj/.test(out.first));
  check('cell shows the engine BASELINE date (' + D(BASE_1) + ') labeled base',
    !!out.first && out.first.includes(D(BASE_1)) && /base/.test(out.first));
  check('after a lotPhases refresh the PROJECTED line MOVES to ' + D(PROJ_2) + ' (not frozen)',
    !!out.afterEst && out.afterEst.includes(D(PROJ_2) + ' proj') && !out.afterEst.includes(D(PROJ_1) + ' proj'));
  check('baseline line correctly UNCHANGED at ' + D(BASE_1) + ' (baseline ignores est)',
    !!out.afterEst && out.afterEst.includes(D(BASE_1) + ' base'));
  check('no lotPhases entry -> em dash, no fabricated date', out.noData === '—');

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
