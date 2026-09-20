'use strict';
// Durable-push executor tests. Runs the REAL executePushLot (extracted from the field app)
// against a mocked backend + real ScheduleEngine. Covers: correct re-read/recompute/writes,
// partial (task absent on target), and — critically — that an EMPTY batch SURFACES as an
// error instead of falsely reporting success (the silent-failure bug).
const fs = require('fs'); const vm = require('vm');
const E = require('../schedule-engine.js'); const SE = (typeof E==='function')?E():E;
const html = fs.readFileSync(__dirname + '/../ashland-stage-update-dev.html','utf8');
const CODE = html.slice(html.indexOf('async function executePushLot(a){'), html.indexOf('async function drainQueue(){'));

function makeEnv(targetRows, bulkResp){
  const calls = [];
  async function sbCallRaw(action, payload){
    calls.push({action, payload});
    if (action==='getScheduleLotTasks') return { tasks: targetRows, gates: [] };
    if (action==='getTemplateStageMap') return { stages: [
      {code:'1.0',label:'Rough',order:1,is_manual:false,triggers:[10]},
      {code:'2.0',label:'Final',order:2,is_manual:false,triggers:[20]} ]};
    if (action==='bulkUpdateLotTasks') return bulkResp ? bulkResp(payload) : { done:(payload.updates||[]).length, failed:[] };
    if (action==='getDelaysForLot') return [{bt_num:10, created_at:'2026-09-05', reason_id:5, reason_label:'Weather', note:'rain', task_name:'Roof', days_late:2, expected_done:'2026-09-01', actual_finish:'2026-09-03'}];
    return {};
  }
  const ctx = { sbCallRaw, ScheduleEngine:SE, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\nthis.__exec = executePushLot;', ctx);
  return { exec: ctx.__exec, calls };
}
let pass=0, fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log((ok?'  ok  - ':'  FAIL- ')+n+(ok?'':'  got '+JSON.stringify(g)+' want '+JSON.stringify(w)));};
const truthy=(n,c)=>{c?pass++:fail++;console.log((c?'  ok  - ':'  FAIL- ')+n);};

(async()=>{
  const rows=[{bt_num:10,id:'T10',status:'not_started',actual_start:null,actual_finish:null},
              {bt_num:20,id:'T20',status:'not_started',actual_start:null,actual_finish:null}];
  const baseIntent=(pushed)=>({kind:'push_lot',mode:'lot',source_lot_id:'L10',source_lot_number:'10',builder:'Matt',
    pushed:pushed, note:null, delays:[], target:{lot_id:'L11',lot_number:'11',community:'CT',template_id:'TPL'}});

  // 1) normal: 10 finished, 20 started -> batch written; stage is NOT written (computed
  //    on read in getScheduleLots now — the single source of truth).
  let env=makeEnv(rows);
  let r=await env.exec(baseIntent([
    {bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'},
    {bt_num:20,status:'started', actual_start:'2026-09-03',actual_finish:null}]));
  const bulk=env.calls.find(c=>c.action==='bulkUpdateLotTasks').payload;
  eq('writes both tasks to target ids', bulk.updates.map(u=>u.task_id), ['T10','T20']);
  eq('does NOT write reported_stage/true_stage (stage computed on read)', [bulk.reported_stage,bulk.true_stage], [undefined,undefined]);
  truthy('does NOT fetch the stage map (no client-side stage recompute)', !env.calls.some(c=>c.action==='getTemplateStageMap'));
  eq('returns done=2', r.done, 2);

  // 2) partial: one pushed task absent on target -> applied ones written, notFound surfaced
  env=makeEnv(rows);
  r=await env.exec(baseIntent([
    {bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'},
    {bt_num:99,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'}]));
  eq('partial: writes the present task', env.calls.find(c=>c.action==='bulkUpdateLotTasks').payload.updates.map(u=>u.task_id), ['T10']);
  eq('partial: notFound surfaces [99]', r.notFound, [99]);

  // 3) THE SILENT-FAILURE FIX: no pushed task matches target -> ERROR, not success
  env=makeEnv(rows);
  r=await env.exec(baseIntent([{bt_num:99,status:'finished',actual_start:null,actual_finish:null}]));
  truthy('empty batch returns an ERROR (never a silent success)', !!(r && r.error));
  truthy('error names pushed vs target tasks (diagnostic)', /pushed tasks \[99\].*target/.test(r.error||''));
  truthy('empty batch did NOT call bulkUpdateLotTasks', !env.calls.some(c=>c.action==='bulkUpdateLotTasks'));

  // 4) SERVER-REJECTED write: server confirms only 1 of 2 -> ERROR (never false success)
  env=makeEnv(rows, (p)=>({ done:1, failed:[{task_id:'T20', error:'date impossible'}] }));
  r=await env.exec(baseIntent([
    {bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'},
    {bt_num:20,status:'started', actual_start:'2026-09-03',actual_finish:null}]));
  truthy('server rejected a write -> ERROR (not synced)', !!(r && r.error));
  truthy('error reports the shortfall/server rejection', /only 1 of 2|server rejected/.test(r.error||''));
  truthy('incomplete push does NOT post note/delay', !env.calls.some(c=>c.action==='addTaskNote'||c.action==='addTaskDelay'));

  // 5) FULL success only when server confirms every write
  env=makeEnv(rows, (p)=>({ done:(p.updates||[]).length, failed:[] }));
  r=await env.exec(baseIntent([{bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'}]));
  truthy('full server confirmation -> success (no error)', !!(r && r.done===1 && !r.error));

  // 6) OFFLINE-origin delays (delays=null): re-read source delays via ONE getDelaysForLot call
  env=makeEnv(rows);
  const offIntent=Object.assign(baseIntent([
    {bt_num:10,status:'finished',actual_start:'2026-09-01',actual_finish:'2026-09-02'},
    {bt_num:20,status:'started', actual_start:'2026-09-03',actual_finish:null}]),
    { delays:null, delays_source:{lot_id:'L10', bts:[10,20]} });
  r=await env.exec(offIntent);
  eq('offline re-read uses ONE getDelaysForLot call (not per-task)', env.calls.filter(c=>c.action==='getDelaysForLot').length, 1);
  truthy('offline re-read: no per-task getDelaysForTask calls', !env.calls.some(c=>c.action==='getDelaysForTask'));
  truthy('offline re-read: inherited delay written to target', env.calls.some(c=>c.action==='addTaskDelay' && c.payload.lot_task_id==='T10'));

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);process.exit(3);});
