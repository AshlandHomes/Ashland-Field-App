/*
 * Browser proof of the collapsed "Closed" lots group in the admin lots table,
 * driving the REAL renderLotsTable() / renderStats() / getFilteredLots() inside
 * admin-dev.html (no copies). Confirms it is DISPLAY-ONLY:
 *   - active lots render up top; closed lots collapse into a bottom group
 *   - default collapsed; toggleClosedGroup() expands
 *   - "N CLOSED" stat unchanged by collapse (counts raw scheduleLots)
 *   - CSV/data layer (getFilteredLots) still returns closed lots regardless
 *   - searching a closed lot auto-expands the group (never hidden)
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

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

  const seed = await page.evaluate(() => {
    // 3 active + 2 closed lots, all one community so sort is by lot number.
    scheduleLots = [
      { id:'a10', community:'RC', lot_number:'10', builder_name:'B', status:'active', reported_stage:'3', scheduled_close_date:null, last_task_update:new Date().toISOString() },
      { id:'a11', community:'RC', lot_number:'11', builder_name:'B', status:'active', reported_stage:'3', scheduled_close_date:null, last_task_update:new Date().toISOString() },
      { id:'a12', community:'RC', lot_number:'12', builder_name:'B', status:'active', reported_stage:'3', scheduled_close_date:null, last_task_update:new Date().toISOString() },
      { id:'c08', community:'RC', lot_number:'8',  builder_name:'B', status:'closed', reported_stage:'6', scheduled_close_date:'2026-08-20', last_task_update:null },
      { id:'c05', community:'RC', lot_number:'5',  builder_name:'B', status:'closed', reported_stage:'6', scheduled_close_date:'2026-07-15', last_task_update:null },
    ];
    lotPhases = {}; flaggedNotesByLot = {}; staleByLot = {};
    // isolate the grouping: stub unrelated cell helpers + subdivision filter
    subBadge=()=>''; stageCell=()=>''; phaseCell=()=>''; staleCell=()=>''; getFilteredSubCodes=()=>null;
    return true;
  });

  // the lots table sits in a hidden tab panel; clone its HTML into a visible
  // wrapper for the screenshot (page CSS still applies — same document).
  const shoot = async (file) => {
    await page.evaluate(() => {
      let w = document.getElementById('shot-wrap');
      if (!w) { w = document.createElement('div'); w.id = 'shot-wrap';
        w.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#fff;padding:16px;z-index:99999'; document.body.appendChild(w); }
      w.innerHTML = document.getElementById('lots-table-body').innerHTML;
    });
    await page.locator('#shot-wrap').screenshot({ path: file });
    await page.evaluate(() => { const w = document.getElementById('shot-wrap'); if (w) w.remove(); });
  };

  const snap = async () => page.evaluate(() => {
    const body = document.getElementById('lots-table-body');
    const dataRows = Array.from(body.querySelectorAll('tbody tr')).filter(tr => !tr.getAttribute('onclick'));
    const hdr = body.querySelector('tbody tr[onclick^="toggleClosedGroup"]');
    return {
      dataRowCount: dataRows.length,
      lotNumbers: dataRows.map(tr => (tr.querySelector('td:nth-child(2)')||{}).textContent||'').map(s=>s.trim()),
      headerText: hdr ? hdr.innerText.replace(/\s+/g,' ').trim() : null,
    };
  });

  // ── collapsed (default) ──
  await page.evaluate(() => renderLotsTable());
  const collapsed = await snap();
  await shoot('/tmp/closed-collapsed.png');

  // ── stat + data-layer checks while collapsed ──
  const dataChecks = await page.evaluate(() => {
    renderStats();
    return {
      statClosed: document.getElementById('stat-closed').textContent,
      filteredTotal: getFilteredLots().length,
      filteredClosed: getFilteredLots().filter(l=>l.status==='closed').length,
    };
  });

  // ── expanded (click header) ──
  await page.evaluate(() => toggleClosedGroup());
  const expanded = await snap();
  await shoot('/tmp/closed-expanded.png');

  // ── collapse again, then SEARCH a closed lot -> should auto-expand ──
  const searchResult = await page.evaluate(() => {
    toggleClosedGroup();                              // back to collapsed
    document.getElementById('lot-search').value = '8'; // matches only closed lot #8
    renderLotsTable();
    const body = document.getElementById('lots-table-body');
    const dataRows = Array.from(body.querySelectorAll('tbody tr')).filter(tr => !tr.getAttribute('onclick'));
    const hdr = body.querySelector('tbody tr[onclick^="toggleClosedGroup"]');
    document.getElementById('lot-search').value = '';  // reset
    return { visibleLots: dataRows.map(tr => tr.querySelector('td:nth-child(2)').textContent.trim()), caret: hdr?hdr.innerText.trim()[0]:null };
  });

  console.log('\n===== ADMIN — closed-lots collapse group (real renderLotsTable) =====\n');
  console.log('  collapsed: rows=' + collapsed.dataRowCount + ' ' + JSON.stringify(collapsed.lotNumbers) + '  header="' + collapsed.headerText + '"');
  console.log('  expanded:  rows=' + expanded.dataRowCount + ' ' + JSON.stringify(expanded.lotNumbers) + '  header="' + expanded.headerText + '"');
  console.log('  stat CLOSED=' + dataChecks.statClosed + '  getFilteredLots total=' + dataChecks.filteredTotal + ' (closed=' + dataChecks.filteredClosed + ')');
  console.log('  search "8": visible=' + JSON.stringify(searchResult.visibleLots) + ' caret=' + searchResult.caret);
  console.log('');

  check('no render errors ('+errors.length+')', errors.length === 0);
  // collapsed: only 3 active rows, closed group header present with count 2, no closed rows
  check('collapsed shows ONLY the 3 active lots', collapsed.dataRowCount === 3 && JSON.stringify(collapsed.lotNumbers) === JSON.stringify(['10','11','12']));
  check('collapsed header reads "▸ 🏠 Closed (2)"', /▸.*Closed \(2\)/.test(collapsed.headerText||''));
  // expanded: 5 rows (3 active + 2 closed), header caret flips
  check('expanded shows all 5 lots (active + closed)', expanded.dataRowCount === 5);
  check('expanded header caret is ▾', /▾.*Closed \(2\)/.test(expanded.headerText||''));
  // data-layer untouched
  check('"N CLOSED" stat = 2 (unaffected by collapse)', dataChecks.statClosed === '2');
  check('getFilteredLots still returns all 5 incl. 2 closed (CSV/data intact)', dataChecks.filteredTotal === 5 && dataChecks.filteredClosed === 2);
  // search finds a closed lot (auto-expand)
  check('searching a closed lot ("8") surfaces it (auto-expand, not hidden)', searchResult.visibleLots.includes('8') && searchResult.caret === '▾');

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
