'use strict';
// THE QUEUE-LOSS GUARANTEE (Collin's non-negotiable): a queued push is NEVER removed
// from the queue until it has ACTUALLY, FULLY applied. This runs the REAL drainQueue +
// executePushLot (extracted from the field app) against a mock OfflineQueue that
// faithfully models the IDB status machine (pending -> synced | failed, never delete),
// and asserts:
//   • transient failure (bad/empty TARGET read, server rejection) -> row stays PENDING
//     (so the next sync retries it) — the exact bug that lost Lots 11 & 12.
//   • permanent failure (pushed tasks match NONE of the target's) -> row retained as
//     FAILED and surfaced — still not deleted.
//   • full apply -> SYNCED.
//   • no code path ever deletes a row.
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const slice = (a,b)=>html.slice(html.indexOf(a), html.indexOf(b));
const CODE_EXEC  = slice('async function executePushLot(a){','// Reconnect-drain report');
const CODE_DRAIN = slice('async function drainQueue(){','async function afterDrain(');

// ── mock OfflineQueue: real status semantics, records every mutation ──
function makeQueue(rows){
  const store = rows.map(r => Object.assign({ status:'pending', attempts:0 }, r));
  let deletes = 0;
  return {
    api: {
      getPending: async () => store.filter(r => r.status === 'pending'),
      getAll:     async () => store.slice(),
      markSynced: async (id) => { const r = store.find(x=>x.id===id); if(r){ r.status='synced'; } },
      markFailed: async (id, reason) => { const r = store.find(x=>x.id===id); if(r){ r.status='failed'; r.failed_reason=reason; r.attempts++; } },
      remapNoteId: async () => 0,
      summary: async () => ({ pending:store.filter(r=>r.status==='pending').length, synced:store.filter(r=>r.status==='synced').length, failed:store.filter(r=>r.status==='failed').length, total:store.length }),
    },
    store, deletes: () => deletes
  };
}

// backend: caller controls the TARGET read + bulk result per scenario
function makeBackend(targetResp, bulkResp){
  return async (action, payload) => {
    if (action==='getScheduleLotTasks') return targetResp();
    if (action==='getTemplateStageMap') return { stages:[{code:'1.0',label:'A',order:1,is_manual:false,triggers:[10]}] };
    if (action==='bulkUpdateLotTasks')  return bulkResp ? bulkResp(payload) : { done:(payload.updates||[]).length, failed:[] };
    if (action==='getDelaysForLot')     return [];
    return {};
  };
}

function run(queue, backend){
  const ctx = {
    OfflineQueue: queue.api, sbCallRaw: backend, ScheduleEngine: SE, console, Promise,
    _isOnline: true, _pushDrainReport: [],
  };
  vm.createContext(ctx);
  vm.runInContext(CODE_EXEC + '\n' + CODE_DRAIN + '\nthis.__drain=drainQueue;', ctx);
  return ctx;
}

const intent = (lot) => ({ id:'row_'+lot, kind:'push_lot', mode:'lot', source_lot_number:'10', builder:'Matt',
  pushed:[{bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'}],
  note:null, delays:[], target:{lot_id:'L'+lot, lot_number:String(lot), community:'CT', template_id:'TPL'} });

const TARGET_ROWS = [{bt_num:10,id:'T10',status:'not_started',actual_start:null,actual_finish:null}];

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

(async()=>{
  // 1) TRANSIENT — target read returns an error -> row MUST stay pending (retryable), NOT failed, NOT deleted.
  {
    const q=makeQueue([intent(11)]);
    const ctx=run(q, makeBackend(()=>({ error:'500 upstream' })));
    await ctx.__drain();
    is('transient (target read error): row stays PENDING', q.store[0].status, 'pending');
    is('transient: row NOT deleted (still 1 row)', q.store.length, 1);
  }

  // 2) TRANSIENT — target returns zero tasks (not loaded yet) -> stays pending.
  {
    const q=makeQueue([intent(11)]);
    const ctx=run(q, makeBackend(()=>({ tasks:[], gates:[] })));
    await ctx.__drain();
    is('transient (target empty read): row stays PENDING', q.store[0].status, 'pending');
  }

  // 3) TRANSIENT — server rejects the write -> stays pending (retry), never failed.
  {
    const q=makeQueue([intent(11)]);
    const ctx=run(q, makeBackend(()=>({ tasks:TARGET_ROWS, gates:[] }), ()=>({ done:0, failed:[{task_id:'T10',error:'db timeout'}] })));
    await ctx.__drain();
    is('transient (server rejected write): row stays PENDING', q.store[0].status, 'pending');
  }

  // 4) PERMANENT — pushed tasks match none of the target's -> retained as FAILED (surfaced), not deleted.
  {
    const q=makeQueue([intent(11)]);
    const ctx=run(q, makeBackend(()=>({ tasks:[{bt_num:99,id:'T99',status:'not_started'}], gates:[] })));
    await ctx.__drain();
    is('permanent (no task matches): row retained as FAILED', q.store[0].status, 'failed');
    is('permanent: row NOT deleted (still present)', q.store.length, 1);
  }

  // 5) SUCCESS — full apply -> SYNCED (only outcome that removes it from pending).
  {
    const q=makeQueue([intent(11)]);
    const ctx=run(q, makeBackend(()=>({ tasks:TARGET_ROWS, gates:[] })));
    await ctx.__drain();
    is('full apply: row SYNCED', q.store[0].status, 'synced');
  }

  // 6) THE ORIGINAL BUG SCENARIO — two queued lots, target reads momentarily fail:
  //    BOTH must remain pending after a pull's drain (the loss reproduced).
  {
    const q=makeQueue([intent(11), intent(12)]);
    const ctx=run(q, makeBackend(()=>({ error:'reconnect race' })));
    await ctx.__drain();
    const pend = q.store.filter(r=>r.status==='pending').length;
    is('two lots, transient reads: BOTH stay pending (nothing lost)', pend, 2);
  }

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
