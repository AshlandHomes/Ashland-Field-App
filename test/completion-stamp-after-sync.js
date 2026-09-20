'use strict';
// Since the single-source refactor, recomputeDerivedAfterSync NO LONGER writes any stage
// (reported_stage is computed on read in getScheduleLots). Its ONLY remaining job is to
// fire the COMPLETION STAMP for the open lot when that lot's task/gate action just synced.
// This runs the REAL (reduced) function and asserts: it never writes a stage, and it
// triggers checkCompletionStamp exactly when the open lot's work synced.
const fs = require('fs'); const vm = require('vm');
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const CODE = html.slice(html.indexOf('async function recomputeDerivedAfterSync(results){'),
                        html.indexOf('// Reconcile a note created OFFLINE'));

function run({ curLot, queue, results }){
  let stamped = 0; const calls = [];
  const ctx = {
    OfflineQueue: { getAll: async () => queue.slice() },
    sbCallRaw: async (action, payload) => { calls.push(action); return {}; },
    sbCall:    async (action, payload) => { calls.push(action); return {}; },
    checkCompletionStamp: async () => { stamped++; },
    curLot, console, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.__run = recomputeDerivedAfterSync;', ctx);
  return { ctx, calls, stampedRef: () => stamped };
}

const taskAction = (id, lot) => ({ id, apiAction:'updateScheduleLotTask', target:{ lot_id: lot } });

let pass=0, fail=0;
const is=(n,g,w)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};

(async()=>{
  // 1) open lot's task synced -> completion stamp fires, and NO stage write happens.
  {
    const queue = [ taskAction('q1','L10'), taskAction('q2','L11') ];
    const env = run({ curLot:{ id:'L10' }, queue, results:{ q1:{}, q2:{} } });
    await env.ctx.__run({ q1:{}, q2:{} });
    is('open lot (L10) work synced -> checkCompletionStamp fired once', env.stampedRef(), 1);
    is('NEVER writes a stage (no updateScheduleLot)', env.calls.includes('updateScheduleLot'), false);
    is('NEVER re-reads lot tasks to recompute a stage (no getScheduleLotTasks)', env.calls.includes('getScheduleLotTasks'), false);
  }

  // 2) only OTHER lots synced (not the open lot) -> no completion stamp (it is curLot-specific).
  {
    const queue = [ taskAction('q1','L11'), taskAction('q2','L12') ];
    const env = run({ curLot:{ id:'L10' }, queue, results:{ q1:{}, q2:{} } });
    await env.ctx.__run({ q1:{}, q2:{} });
    is('other lots synced, open lot untouched -> stamp NOT fired', env.stampedRef(), 0);
  }

  // 3) no open lot -> no-op.
  {
    const queue = [ taskAction('q1','L10') ];
    const env = run({ curLot:null, queue, results:{ q1:{} } });
    await env.ctx.__run({ q1:{} });
    is('no open lot -> no-op (no stamp)', env.stampedRef(), 0);
  }

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
