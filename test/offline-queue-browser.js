/*
 * Persistence proof for offline-queue.js (Layer 1). Real Chromium + real
 * IndexedDB, served over localhost so the origin is stable across a page RELOAD.
 * Proves: enqueue works; actions read back in (timestamp, seq) order; status
 * transitions (synced/failed) work; and — the point — ALL of it SURVIVES a full
 * page reload (durable across app close / phone restart).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const QJS = fs.readFileSync(path.resolve(__dirname, '..', 'offline-queue.js'), 'utf8');
const HARNESS = '<!doctype html><meta charset="utf-8"><title>oq-harness</title>'
  + '<script src="/offline-queue.js"></script><body>offline-queue harness';

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.indexOf('/offline-queue.js') === 0) { res.setHeader('Content-Type', 'application/javascript'); res.end(QJS); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(HARNESS); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // start clean, then enqueue 3 actions:
  //  - finish  @10:00  (enqueued 1st -> seq lowest, but LATEST timestamp)
  //  - start   @09:00  (enqueued 2nd)
  //  - note    @09:00  (enqueued 3rd -> SAME ts as start -> seq breaks the tie)
  const preReload = await page.evaluate(async () => {
    await OfflineQueue._clearAll();
    const f = await OfflineQueue.enqueue({ type:'finish', apiAction:'updateScheduleLotTask',
      target:{lot_id:'L1', task_id:'t2'}, payload:{task_id:'t2', status:'finished', actual_finish:'2026-08-27'},
      timestamp:'2026-08-27T10:00:00.000Z', builder:'Marisa' });
    const s = await OfflineQueue.enqueue({ type:'start', apiAction:'updateScheduleLotTask',
      target:{lot_id:'L1', task_id:'t1'}, payload:{task_id:'t1', status:'started', actual_start:'2026-08-27'},
      timestamp:'2026-08-27T09:00:00.000Z', builder:'Marisa' });
    const n = await OfflineQueue.enqueue({ type:'note', apiAction:'addTaskNote',
      target:{lot_id:'L1', task_id:'t1'}, payload:{lot_task_id:'t1', note:'leak', flag:'red', author:'Marisa'},
      timestamp:'2026-08-27T09:00:00.000Z', builder:'Marisa' });
    const all = await OfflineQueue.getAll();
    return { order: all.map(a => a.type), ids: { f:f.id, s:s.id, n:n.id },
             seqs: { f:f.seq, s:s.seq, n:n.seq },
             stampedPending: all.every(a => a.status === 'pending' && a.attempts === 0 && a.id) };
  });

  // status transitions: mark the START synced, the NOTE failed.
  const afterMark = await page.evaluate(async (ids) => {
    await OfflineQueue.markSynced(ids.s);
    await OfflineQueue.markFailed(ids.n, 'HTTP 500');
    const pending = await OfflineQueue.getPending();
    return { pendingTypes: pending.map(a => a.type) };
  }, preReload.ids);

  // ── *** RELOAD THE PAGE *** (durability across app close / phone restart) ──
  await page.reload({ waitUntil: 'domcontentloaded' });

  const postReload = await page.evaluate(async () => {
    const all = await OfflineQueue.getAll();
    const pending = await OfflineQueue.getPending();
    const summary = await OfflineQueue.summary();
    const byType = {}; all.forEach(a => { byType[a.type] = a; });
    return {
      count: all.length,
      order: all.map(a => a.type),
      pendingTypes: pending.map(a => a.type),
      startStatus: byType.start && byType.start.status,
      noteStatus: byType.note && byType.note.status,
      noteReason: byType.note && byType.note.failed_reason,
      noteAttempts: byType.note && byType.note.attempts,
      finishStatus: byType.finish && byType.finish.status,
      finishPayload: byType.finish && byType.finish.payload,   // full payload survived
      summary,
    };
  });

  console.log('\n===== offline-queue Layer 1 — durable queue (real IndexedDB + reload) =====\n');
  console.log('  pre-reload  order: ' + JSON.stringify(preReload.order) + '  seqs: ' + JSON.stringify(preReload.seqs));
  console.log('  after mark  pending: ' + JSON.stringify(afterMark.pendingTypes));
  console.log('  POST-RELOAD order: ' + JSON.stringify(postReload.order) + '  count: ' + postReload.count);
  console.log('  POST-RELOAD statuses: start=' + postReload.startStatus + ' note=' + postReload.noteStatus
    + '("' + postReload.noteReason + '",attempts=' + postReload.noteAttempts + ') finish=' + postReload.finishStatus);
  console.log('');

  check('no page errors ('+errors.length+')', errors.length === 0);
  // ordering: timestamp asc then seq -> start(09:00,seq2), note(09:00,seq3), finish(10:00,seq1)
  check('pre-reload: enqueue stamped id/pending/attempts=0', preReload.stampedPending);
  check('pre-reload: order is (timestamp, seq) -> [start, note, finish]',
    JSON.stringify(preReload.order) === JSON.stringify(['start','note','finish']));
  check('pre-reload: seq is monotonic insertion order (finish=1, start=2, note=3)',
    preReload.seqs.f === 1 && preReload.seqs.s === 2 && preReload.seqs.n === 3);
  check('after mark: getPending excludes synced+failed -> only [finish]',
    JSON.stringify(afterMark.pendingTypes) === JSON.stringify(['finish']));

  // THE PROOF: everything survived the reload
  check('RELOAD: all 3 actions persisted', postReload.count === 3);
  check('RELOAD: order preserved [start, note, finish]',
    JSON.stringify(postReload.order) === JSON.stringify(['start','note','finish']));
  check('RELOAD: start stayed synced', postReload.startStatus === 'synced');
  check('RELOAD: note stayed failed with reason + attempts=1',
    postReload.noteStatus === 'failed' && postReload.noteReason === 'HTTP 500' && postReload.noteAttempts === 1);
  check('RELOAD: finish stayed pending', postReload.finishStatus === 'pending');
  check('RELOAD: getPending after reload is still [finish]',
    JSON.stringify(postReload.pendingTypes) === JSON.stringify(['finish']));
  check('RELOAD: full replay payload survived intact',
    postReload.finishPayload && postReload.finishPayload.status === 'finished' && postReload.finishPayload.actual_finish === '2026-08-27');
  check('RELOAD: summary() counts = {pending:1, synced:1, failed:1, total:3}',
    postReload.summary && postReload.summary.pending===1 && postReload.summary.synced===1 && postReload.summary.failed===1 && postReload.summary.total===3);

  if (errors.length) { console.log('\nERRORS:'); errors.forEach(e=>console.log('  '+e)); }
  console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
  await browser.close();
  server.close();
  process.exit(allPass ? 0 : 1);
})();
