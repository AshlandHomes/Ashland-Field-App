/*
 * Browser proof of the by-community collapsible groups in the admin lots table,
 * driving the REAL renderLotsTable() / renderStats() / getFilteredLots() inside
 * admin-dev.html (no copies). Confirms:
 *   - active lots group by community (code + name + count), default EXPANDED
 *   - lot_number order preserved WITHIN each community group
 *   - the "🏠 Closed (N)" group stays LAST and default collapsed
 *   - toggling one community folds only that community
 *   - a text SEARCH force-expands groups (a match is never hidden)
 *   - DISPLAY-ONLY: stat counts, getFilteredLots (CSV), search all intact
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

  await page.evaluate(() => {
    const now = new Date().toISOString();
    const mk = (community, lot_number, status) => ({ id: community+lot_number, community, lot_number, status,
      builder_name:'B', reported_stage:'3', scheduled_close_date: status==='closed'?'2026-08-20':null, last_task_update: now });
    // CO active {5,12,3}, CT active {1,2}, RC closed {8,5}
    scheduleLots = [ mk('CO','5','active'), mk('CO','12','active'), mk('CO','3','active'),
                     mk('CT','1','active'), mk('CT','2','active'),
                     mk('RC','8','closed'), mk('RC','5','closed') ];
    SUB_NAMES = { CO:'Cornerstone', CT:'Cottonwood', RC:'Ridge' };
    lotPhases = {}; flaggedNotesByLot = {}; staleByLot = {};
    subBadge=()=>''; stageCell=()=>''; phaseCell=()=>''; staleCell=()=>''; getFilteredSubCodes=()=>null;
    communityCollapsed = new Set(); closedExpanded = false;
  });

  const shoot = async (file) => {
    await page.evaluate(() => {
      let w = document.getElementById('shot-wrap');
      if (!w) { w = document.createElement('div'); w.id='shot-wrap';
        w.style.cssText='position:fixed;top:0;left:0;right:0;background:#fff;padding:16px;z-index:99999'; document.body.appendChild(w); }
      w.innerHTML = document.getElementById('lots-table-body').innerHTML;
    });
    await page.locator('#shot-wrap').screenshot({ path: file });
    await page.evaluate(() => { const w=document.getElementById('shot-wrap'); if (w) w.remove(); });
  };

  // read the tbody as an ordered sequence of group-headers and data rows
  const snap = async () => page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('#lots-table-body tbody tr'));
    const seq = trs.map(tr => {
      const oc = tr.getAttribute('onclick') || '';
      if (oc.startsWith('toggleCommunityGroup')) return { t:'commHdr', text: tr.innerText.replace(/\s+/g,' ').trim() };
      if (oc.startsWith('toggleClosedGroup'))    return { t:'closedHdr', text: tr.innerText.replace(/\s+/g,' ').trim() };
      return { t:'row', lot: (tr.querySelector('td:nth-child(2)')||{}).textContent.trim() };
    });
    return seq;
  });

  // ── default render ──
  await page.evaluate(() => renderLotsTable());
  const def = await snap();
  await shoot('/tmp/comm-default.png');

  const commHeaders = def.filter(x=>x.t==='commHdr').map(x=>x.text);
  const dataLots    = def.filter(x=>x.t==='row').map(x=>x.lot);
  const closedHdr   = def.find(x=>x.t==='closedHdr');
  // lot_number order within CO: headers/rows are sequential, so slice CO's rows
  const coStart = def.findIndex(x=>x.t==='commHdr' && /^▾ CO/.test(x.text));
  const coRows = []; for (let i=coStart+1;i<def.length && def[i].t==='row';i++) coRows.push(def[i].lot);

  // data-layer checks
  const dataChecks = await page.evaluate(() => { renderStats(); return {
    statClosed: document.getElementById('stat-closed').textContent,
    statActive: document.getElementById('stat-active').textContent,
    filteredTotal: getFilteredLots().length,
    filteredClosed: getFilteredLots().filter(l=>l.status==='closed').length }; });

  // ── collapse ONE community (CT), expand Closed, screenshot ──
  await page.evaluate(() => { toggleCommunityGroup('CT'); toggleClosedGroup(); });
  const mixed = await snap();
  await shoot('/tmp/comm-mixed.png');
  const ctHdr = mixed.find(x=>x.t==='commHdr' && /CT/.test(x.text));
  const ctCollapsedNoRows = (() => { const i = mixed.findIndex(x=>x.t==='commHdr'&&/CT/.test(x.text)); return mixed[i+1] && mixed[i+1].t !== 'row' || i===mixed.length-1; })();
  const coStillExpanded = (() => { const i = mixed.findIndex(x=>x.t==='commHdr'&&/^▾ CO/.test(x.text)); return i>=0 && mixed[i+1] && mixed[i+1].t==='row'; })();

  // ── restore, collapse CO, then SEARCH a CO lot -> auto-expand ──
  const searchRes = await page.evaluate(() => {
    toggleClosedGroup();                    // closed back to collapsed
    communityCollapsed = new Set(['CO']);   // CO folded
    document.getElementById('lot-search').value = '12';  // CO lot 12
    renderLotsTable();
    const trs = Array.from(document.querySelectorAll('#lots-table-body tbody tr'));
    const rowLots = trs.filter(tr=>!tr.getAttribute('onclick')).map(tr=>tr.querySelector('td:nth-child(2)').textContent.trim());
    const coHdr = trs.map(tr=>tr.innerText.replace(/\s+/g,' ').trim()).find(t=>/CO/.test(t));
    document.getElementById('lot-search').value = '';
    return { rowLots, coCaret: coHdr ? coHdr[0] : null };
  });

  console.log('\n===== ADMIN — by-community groups (real renderLotsTable) =====\n');
  console.log('  community headers: ' + JSON.stringify(commHeaders));
  console.log('  data lots order:   ' + JSON.stringify(dataLots));
  console.log('  CO rows (lot_number order): ' + JSON.stringify(coRows));
  console.log('  closed header:     "' + (closedHdr?closedHdr.text:'(none)') + '"');
  console.log('  stats: active=' + dataChecks.statActive + ' closed=' + dataChecks.statClosed + '  getFilteredLots=' + dataChecks.filteredTotal + ' (closed=' + dataChecks.filteredClosed + ')');
  console.log('  after collapse CT: header="' + (ctHdr?ctHdr.text:'') + '"  CO still expanded=' + coStillExpanded);
  console.log('  search "12" (CO folded): rows=' + JSON.stringify(searchRes.rowLots) + ' CO caret=' + searchRes.coCaret);
  console.log('');

  check('no render errors ('+errors.length+')', errors.length === 0);
  check('two community groups, CO then CT, with names + counts',
    commHeaders.length===2 && /^▾ CO · Cornerstone \(3\)$/.test(commHeaders[0]) && /^▾ CT · Cottonwood \(2\)$/.test(commHeaders[1]));
  check('default: all 5 active rows visible', dataLots.length===5);
  check('lot_number order within CO is 3,5,12 (numeric)', JSON.stringify(coRows)===JSON.stringify(['3','5','12']));
  check('Closed group present, collapsed (▸), and LAST', !!closedHdr && /^▸ 🏠 Closed \(2\)$/.test(closedHdr.text) && def[def.length-1].t==='closedHdr');
  check('collapsing CT folds only CT (▸, no CT rows) — CO stays expanded', /^▸ CT/.test(ctHdr?ctHdr.text:'') && ctCollapsedNoRows && coStillExpanded);
  check('stats unaffected: active=5, closed=2', dataChecks.statActive==='5' && dataChecks.statClosed==='2');
  check('getFilteredLots intact: 7 total incl. 2 closed (CSV/data)', dataChecks.filteredTotal===7 && dataChecks.filteredClosed===2);
  check('search "12" in folded CO auto-expands and shows it', searchRes.rowLots.includes('12') && searchRes.coCaret==='▾');

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
