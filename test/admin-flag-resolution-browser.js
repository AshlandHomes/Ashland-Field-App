/*
 * Browser proof of the admin red-flag resolution UI, driving the REAL
 * openFlagsModal() / sendResolutionRequest() inside admin-dev.html (no copies).
 * Confirms:
 *   - each red-flag state renders correctly (open / asked / confirmed_open),
 *     using the shared NoteResolution.deriveState (not a separate calc)
 *   - yellow flags get NO resolution UI (red-only, per decision)
 *   - clicking a canned button calls requestNoteResolution with the right prompt
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

const T1 = '2026-08-26T22:06:05.000Z';   // requested
const T2 = '2026-08-27T15:00:00.000Z';   // responded

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
    : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '..', 'admin-dev.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;

  const out = await page.evaluate((cfg) => {
    scheduleLots = [{ id:'lotA', community:'CO', lot_number:'12', builder_name:'Marisa' }];
    flaggedNotesByLot = { lotA: [
      { id:'n_open', lot_id:'lotA', bt_num:84, note:'Leak at rear window', flag:'red', author:'Marisa', created_at:cfg.T1,
        resolution_requested_at:null, resolution_prompt:null, resolution_response:null, resolution_responded_at:null },
      { id:'n_asked', lot_id:'lotA', bt_num:88, note:'Tile crack', flag:'red', author:'Marisa', created_at:cfg.T1,
        resolution_requested_at:cfg.T1, resolution_prompt:'Has this been resolved?', resolution_response:null, resolution_responded_at:null },
      { id:'n_conf', lot_id:'lotA', bt_num:95, note:'Paint run', flag:'red', author:'Marisa', created_at:cfg.T1,
        resolution_requested_at:cfg.T1, resolution_prompt:'Has this been resolved?', resolution_response:'still_open', resolution_responded_at:cfg.T2 },
      { id:'n_yellow', lot_id:'lotA', bt_num:70, note:'Reminder: order trim', flag:'yellow', author:'Marisa', created_at:cfg.T1,
        resolution_requested_at:null, resolution_prompt:null, resolution_response:null, resolution_responded_at:null },
    ]};
    // capture endpoint calls; neutralize the post-send refresh
    const calls = [];
    sbCall = async (action, payload) => { calls.push({ action, payload }); return {}; };
    loadFlaggedNotes = async () => {};
    renderLotsTable = () => {};
    window.__calls = calls;

    openFlagsModal('lotA');
    const items = Array.from(document.querySelectorAll('#flags-modal-list .flag-item')).map(it => ({
      text: it.innerText.replace(/\s+/g,' ').trim(),
      buttons: Array.from(it.querySelectorAll('button')).map(b => b.textContent.trim()),
    }));
    return { items };
  }, { T1, T2 });

  console.log('\n===== ADMIN — red-flag resolution UI (real openFlagsModal) =====\n');
  out.items.forEach(it => { console.log('  • ' + it.text); if (it.buttons.length) console.log('      buttons: ' + JSON.stringify(it.buttons)); });
  console.log('');

  const open  = out.items.find(i => /Leak at rear window/.test(i.text));
  const asked = out.items.find(i => /Tile crack/.test(i.text));
  const conf  = out.items.find(i => /Paint run/.test(i.text));
  const yellow= out.items.find(i => /order trim/.test(i.text));

  check('no render errors ('+errors.length+')', errors.length === 0);
  check('OPEN red flag: "Ask builder:" + the SINGLE canned button, no state label',
    open && /Ask builder:/.test(open.text) && open.buttons.length===1
    && open.buttons[0]==='Has this been resolved?');
  check('ASKED red flag: shows "Resolution requested" + the sent prompt + "Ask again:"',
    asked && /Resolution requested/i.test(asked.text) && /Has this been resolved\?/.test(asked.text) && /Ask again:/.test(asked.text) && asked.buttons.length===1);
  check('CONFIRMED-OPEN red flag: shows "Builder confirmed still open"',
    conf && /Builder confirmed still open/i.test(conf.text) && conf.buttons.length===1);
  check('YELLOW flag: NO resolution UI (no buttons)',
    yellow && yellow.buttons.length===0 && !/Ask builder/.test(yellow.text));

  // click the FIRST canned button on the OPEN flag -> requestNoteResolution
  const clickResult = await page.evaluate(async () => {
    window.__calls.length = 0;
    const openItem = Array.from(document.querySelectorAll('#flags-modal-list .flag-item')).find(it => /Leak at rear window/.test(it.innerText));
    openItem.querySelector('button').click();
    await new Promise(r => setTimeout(r, 0));
    return window.__calls[0];
  });
  console.log('  click →', JSON.stringify(clickResult), '\n');
  check('clicking a canned button calls requestNoteResolution with {id, prompt}',
    clickResult && clickResult.action==='requestNoteResolution' && clickResult.payload.id==='n_open'
    && clickResult.payload.prompt==='Has this been resolved?');

  // screenshot the modal
  await page.locator('#flags-modal-list').screenshot({ path: '/tmp/flag-resolution.png' });
  console.log('screenshot -> /tmp/flag-resolution.png');

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
