/*
 * Browser proof of the field-app on-open resolution modal, driving the REAL
 * checkPendingResolutions() / appModal() inside ashland-stage-update-dev.html.
 * Confirms:
 *   - one modal at a time (QUEUE) for multiple pending requests
 *   - each shows lot + task + note + the admin's prompt
 *   - Yes -> respondNoteResolution 'resolved';  No -> 'still_open'
 *   - "Not sure yet" -> NO endpoint call (stays pending, re-asked next open)
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
  await page.route('**/*', r => {
    const u = r.request().url();
    // config endpoint answers with a secret so the startup connectivity probe reads ONLINE
    if (u.includes('/.netlify/functions/config')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"secret":""}' });
    if (u.startsWith('file://')) return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('file://' + path.resolve(__dirname, '..', 'ashland-stage-update-dev.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;

  // seed builder + 3 pending requests; capture respond calls; start the queue.
  await page.evaluate(() => {
    currentBuilder = 'Marisa'; _isOnline = true;   // feature test: force online (drain runs)
    const pending = [
      { id:'n1', lot_number:'12', community:'CO', bt_num:84, note:'Leak at rear window', resolution_prompt:'Has this been resolved?' },
      { id:'n2', lot_number:'8',  community:'CT', bt_num:88, note:'Tile crack',          resolution_prompt:"Please update — what's the current status?" },
      { id:'n3', lot_number:'5',  community:'CO', bt_num:95, note:'Paint run',           resolution_prompt:'Has this been resolved?' },
    ];
    window.__calls = [];
    sbCallRaw = async (action, payload) => {
      if (action === 'getPendingResolutions') return pending;
      window.__calls.push({ action, payload });
      return {};
    };
    window.__queue = checkPendingResolutions();   // fire; resolves when queue drains
  });

  // answer one modal, return what it showed
  const answer = async (buttonIncludes) => {
    await page.waitForSelector('#fm-overlay', { timeout: 3000 });
    const info = await page.evaluate(() => {
      const ov = document.getElementById('fm-overlay');
      return { title: ov.querySelector('.dr-title').innerText.replace(/\s+/g,' ').trim(),
               sub: ov.querySelector('.dr-sub').innerText.replace(/\s+/g,' ').trim(),
               buttons: Array.from(ov.querySelectorAll('.fm-btn')).map(b => b.textContent.trim()) };
    });
    await page.evaluate((lbl) => {
      const ov = document.getElementById('fm-overlay');
      Array.from(ov.querySelectorAll('.fm-btn')).find(b => b.textContent.includes(lbl)).click();
    }, buttonIncludes);
    await page.waitForTimeout(40);   // let removal + next queue item mount
    return info;
  };

  const m1 = await answer('Yes');        // n1 -> resolved
  const m2 = await answer('No');         // n2 -> still_open
  const m3 = await answer('Not sure');   // n3 -> skip (no call)
  await page.evaluate(() => window.__queue);   // queue fully drained

  const calls = await page.evaluate(() => window.__calls);
  const noOverlay = await page.evaluate(() => !document.getElementById('fm-overlay'));

  console.log('\n===== FIELD APP — on-open resolution modal (real checkPendingResolutions) =====\n');
  [m1,m2,m3].forEach((m,i)=>{ console.log('  Q'+(i+1)+' title: '+m.title); console.log('       sub: '+m.sub); console.log('       buttons: '+JSON.stringify(m.buttons)); });
  console.log('  respond calls: ' + JSON.stringify(calls));
  console.log('');

  check('no errors ('+errors.length+')', errors.length === 0);
  check('Q1 shows lot 12, task #84, the note, and the prompt',
    /Lot 12/.test(m1.title) && /#84/.test(m1.sub) && /Leak at rear window/.test(m1.sub) && /Has this been resolved\?/.test(m1.sub));
  check('every question offers Yes / No / Not sure (3 buttons)',
    m1.buttons.length===3 && /Yes/.test(m1.buttons[0]) && /No/.test(m1.buttons[1]) && /Not sure/.test(m1.buttons[2]));
  check('queue: showed all 3, one at a time', !!m1.title && !!m2.title && !!m3.title && /Lot 8/.test(m2.title) && /Lot 5/.test(m3.title));
  check('Yes -> respondNoteResolution(n1, resolved)',
    calls.some(c => c.action==='respondNoteResolution' && c.payload.id==='n1' && c.payload.response==='resolved'));
  check('No -> respondNoteResolution(n2, still_open)',
    calls.some(c => c.action==='respondNoteResolution' && c.payload.id==='n2' && c.payload.response==='still_open'));
  check('"Not sure yet" -> NO endpoint call for n3 (stays pending)',
    !calls.some(c => c.payload && c.payload.id==='n3'));
  check('exactly 2 respond calls total (n1, n2)', calls.filter(c=>c.action==='respondNoteResolution').length===2);
  check('queue closed cleanly (no lingering modal)', noOverlay);

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
