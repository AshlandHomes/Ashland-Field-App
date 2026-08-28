/*
 * BUG FIX proof — bulk push progress bar reflects COMPLETED, not reached.
 * ---------------------------------------------------------------------------
 * The bug: the bar hit 100% the instant the loop REACHED the last lot, while that
 * lot's write was still in flight — builders saw full green, closed early, and lost
 * the final push. This drives the REAL _bpApply() with the LAST lot's write gated on
 * a manual release, and proves:
 *   - while the last push is in flight: bar is NOT 100% (visible sliver), message
 *     says "Pushing lot N of N — keep open", the "don't close" warn is visible, and
 *     the beforeunload close-guard is ARMED.
 *   - only AFTER the final push confirms: bar = 100%, title "✓ Done", guard released.
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
  page.on('dialog', d => d.dismiss());                 // auto-dismiss the summary alert
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue()
    : r.fulfill({ status:200, contentType:'application/json', body:'{}' }));
  await page.goto('file://' + path.resolve(__dirname, '..', 'ashland-stage-update-dev.html'), { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(150); errors.length = 0;

  // seed a 3-lot task push; gate the 3rd (last) lot's write on window.__release
  await page.evaluate(() => {
    currentBuilder='Marisa';
    curLot={ id:'SRC', lot_number:'1', community:'CO', builder_name:'Marisa' };
    _bpMode='task'; _bpBtNum=84;
    bn={84:{_id:'t84',num:84,name:'Trim'}}; act={84:{started:true,finished:true,start:'2026-08-20',finish:'2026-08-22'}};
    _bpTargets=[{id:'L1',lot_number:'11',community:'CO',template_id:null},
                {id:'L2',lot_number:'12',community:'CO',template_id:null},
                {id:'L3',lot_number:'13',community:'CO',template_id:null}];
    _bpSelected={L1:true,L2:true,L3:true};
    loadMyLots=async()=>{};                              // no-op refresh
    let writes=0;
    sbCall=async(action,payload)=>{
      if(action==='getScheduleLotTasks') return { tasks:[{id:payload.lot_id+'-k',bt_num:84,status:'not_started',actual_start:null,actual_finish:null}], gates:[] };
      if(action==='getTemplateStageMap') return { stages:[] };
      if(action==='getDelaysForTask') return null;
      if(action==='bulkUpdateLotTasks'){
        writes++;
        if(writes===3){ return new Promise(res => { window.__release = () => res({done:1, failed:[]}); }); }  // LAST lot blocks
        return { done:1, failed:[] };
      }
      return {};
    };
    window.__done = _bpApply();                          // fire; blocks on the 3rd write
  });

  // wait until the loop is on the LAST lot (2 done, 3rd in flight)
  await page.waitForFunction(() => {
    const l = document.getElementById('bp-prog-label');
    return l && /Pushing lot 3 of 3/.test(l.textContent);
  }, { timeout: 4000 });

  const inflight = await page.evaluate(() => {
    const fill=document.getElementById('bp-progfill');
    const warn=document.getElementById('bp-prog-warn');
    return { width: fill ? fill.style.width : null,
             label: (document.getElementById('bp-prog-label')||{}).textContent,
             title: (document.getElementById('bp-prog-title')||{}).textContent,
             warnVisible: !!(warn && warn.style.display !== 'none'),
             guardArmed: _bpInFlight === true };
  });

  // now release the final write; the bar should complete to 100% "✓ Done"
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => {
    const t = document.getElementById('bp-prog-title');
    const f = document.getElementById('bp-progfill');
    return t && /Done/.test(t.textContent) && f && f.style.width === '100%';
  }, { timeout: 4000 });
  const done = await page.evaluate(() => ({
    width: (document.getElementById('bp-progfill')||{}).style.width,
    title: (document.getElementById('bp-prog-title')||{}).textContent,
    label: (document.getElementById('bp-prog-label')||{}).textContent,
    guardArmed: _bpInFlight === true
  }));

  console.log('\n===== Bulk-push progress: completed-based, not reached =====\n');
  console.log('  LAST LOT IN FLIGHT: ' + JSON.stringify(inflight));
  console.log('  AFTER FINAL CONFIRM: ' + JSON.stringify(done));
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  // the bug: was 100% here. fix: sliver remaining (2/3 = 67%).
  check('IN FLIGHT: bar is NOT 100% (shows a sliver — 67%)', inflight.width === '67%');
  check('IN FLIGHT: message says "Pushing lot 3 of 3 — keep open"', /Pushing lot 3 of 3/.test(inflight.label||'') && /keep open/.test(inflight.label||''));
  check('IN FLIGHT: title still "Applying push…" (NOT done)', /Applying push/.test(inflight.title||''));
  check('IN FLIGHT: "don\'t close" warning is visible', inflight.warnVisible === true);
  check('IN FLIGHT: beforeunload close-guard is ARMED', inflight.guardArmed === true);
  check('AFTER CONFIRM: bar reaches 100%', done.width === '100%');
  check('AFTER CONFIRM: title flips to "✓ Done"', /Done/.test(done.title||''));
  check('AFTER CONFIRM: close-guard released', done.guardArmed === false);

  if (errors.length){ console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
