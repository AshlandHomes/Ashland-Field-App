/*
 * Layer 2 proof: all four builder actions ROUTE THROUGH the durable queue and,
 * while ONLINE, sync instantly (behavior unchanged). Loads the REAL field app
 * (ashland-stage-update-dev.html) over localhost so the real functions +
 * OfflineQueue + real IndexedDB are all in play. sbCall is stubbed to record
 * calls and succeed (simulating a healthy online backend). We drive the real
 * saveTask / addNote / checkPendingResolutions and assert each produced a
 * SYNCED queue action with the right apiAction, and that sbCall was invoked.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'ashland-stage-update-dev.html'), 'utf8');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.indexOf('/.netlify/functions/config') === 0) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ secret: '' })); }
    if (u.indexOf('/.netlify/functions/') === 0) { res.setHeader('Content-Type','application/json'); return res.end('[]'); }
    if (u === '/' || u === '') { res.setHeader('Content-Type','text/html'); return res.end(HTML); }
    const f = path.join(ROOT, u.replace(/^\//,''));
    if (f.indexOf(ROOT) === 0 && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f);
      res.setHeader('Content-Type', ext==='.js'?'application/javascript':(ext==='.json'?'application/json':'text/plain'));
      return res.end(fs.readFileSync(f));
    }
    res.statusCode = 404; res.end('');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200); errors.length = 0;   // drop offline-startup noise

  const out = await page.evaluate(async () => {
    await OfflineQueue._clearAll();
    // stub sbCallRaw — the drain (and the interactive sbCall wrapper) both use it.
    const calls = [];
    sbCallRaw = async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'addTaskNote') return [{ id: 'srv-note-1', flag: payload.flag }];
      return {};
    };
    // isolate the queue routing from derived side-effects + UI
    saveStage = async () => {}; checkCompletionStamp = async () => {};
    renderThread = () => {}; renderFlagBtns = () => {}; renderTasks = () => {};

    currentBuilder = 'Marisa';
    curLot = { id: 'L1', lot_number: '12', builder_name: 'Marisa' };
    const t = { _id: 'task-1', num: 84, name: 'Trim' };
    bn = { 84: t }; TASKS = [t];
    lotNotes = [];

    // 1) START (via saveTask, the shared start/finish/undo write)
    act = { 84: { started: true, finished: false, start: '2026-08-27', finish: null } };
    await saveTask(t);

    // 2) FINISH (same helper, finished state)
    act = { 84: { started: true, finished: true, start: '2026-08-27', finish: '2026-08-28' } };
    await saveTask(t);

    // 3) NOTE (via addNote)
    noteTaskNum = 84; noteFlag = 'red';
    document.getElementById('note-text').value = 'Leak at rear window';
    const m = document.getElementById('note-multi'); if (m) m.checked = false;
    await addNote();

    // 4) FLAG RESPONSE (via checkPendingResolutions -> appModal -> Yes)
    const origRaw = sbCallRaw;
    sbCallRaw = async (action, payload) => {
      if (action === 'getPendingResolutions') return [{ id: 'note-x', lot_id: 'L1', lot_number: '12', bt_num: 84, note: 'Paint run', resolution_prompt: 'Has this been resolved?' }];
      return origRaw(action, payload);
    };
    const p = checkPendingResolutions();
    await new Promise(r => setTimeout(r, 0));
    // click "Yes, resolved"
    const ov = document.getElementById('fm-overlay');
    Array.from(ov.querySelectorAll('.fm-btn')).find(b => /Yes/.test(b.textContent)).click();
    await p;

    const all = await OfflineQueue.getAll();
    const summary = await OfflineQueue.summary();
    return {
      queued: all.map(a => ({ type: a.type, apiAction: a.apiAction, status: a.status })),
      summary,
      sbActions: calls.map(c => c.action),
      noteInList: lotNotes.map(n => ({ id: n.id, note: n.note })),
    };
  });

  console.log('\n===== Layer 2 — builder actions route through the queue (real field app) =====\n');
  out.queued.forEach(q => console.log('  queued: ' + JSON.stringify(q)));
  console.log('  summary: ' + JSON.stringify(out.summary));
  console.log('  sbCall actions: ' + JSON.stringify(out.sbActions));
  console.log('  lotNotes: ' + JSON.stringify(out.noteInList));
  console.log('');

  const byType = t => out.queued.filter(q => q.type === t);
  check('no page errors ('+errors.length+')', errors.length === 0);
  check('START routed: a synced updateScheduleLotTask action',
    byType('start').length===1 && byType('start')[0].apiAction==='updateScheduleLotTask' && byType('start')[0].status==='synced');
  check('FINISH routed: a synced updateScheduleLotTask action',
    byType('finish').length===1 && byType('finish')[0].status==='synced');
  check('NOTE routed: a synced addTaskNote action',
    byType('note').length===1 && byType('note')[0].apiAction==='addTaskNote' && byType('note')[0].status==='synced');
  check('FLAG_RESPONSE routed: a synced respondNoteResolution action',
    byType('flag_response').length===1 && byType('flag_response')[0].apiAction==='respondNoteResolution' && byType('flag_response')[0].status==='synced');
  check('all 4 synced instantly (0 pending, 0 failed) — invisible when online',
    out.summary.synced===4 && out.summary.pending===0 && out.summary.failed===0 && out.summary.total===4);
  check('each queued action actually hit the backend (sbCall invoked)',
    ['updateScheduleLotTask','addTaskNote','respondNoteResolution'].every(a => out.sbActions.includes(a)));
  check('online note used the SERVER row id (behavior unchanged)',
    out.noteInList.length===1 && out.noteInList[0].id==='srv-note-1');

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
