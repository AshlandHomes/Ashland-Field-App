'use strict';
// _finishedBeforePredWarnings (D-3) must only blame the COPY for predecessor edges it
// ADDS/changes. An edge already on the target today is reported distinctly
// (finished_before_predecessor_existing / already_on_target) — never as "caused by the copy".
// This is the Lot-31->32 empty-diff case where task 4's pred-2 condition pre-existed.
const api = require('../netlify/functions/supabase.js');
const warn = api._finishedBeforePredWarnings;

let pass = 0, fail = 0;
function is(name, got, want) {
  const ok = got === want; ok ? pass++ : fail++;
  console.log((ok ? '  ok  - ' : '  FAIL- ') + name + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}
const find = (arr, rule, num) => arr.find(w => w.rule === rule && w.num === num);

// Target today: task 4 (finished) depends on 2 (not finished) — a PRE-EXISTING condition.
const current = [
  { bt_num:2, name:'Pred',  status:'not_started', predecessors:[] },
  { bt_num:4, name:'Clearing', status:'finished', predecessors:[2] },
  { bt_num:6, name:'Later', status:'not_started', predecessors:[4] },
];

// (1) EMPTY diff — proposed identical to current → the 4<-2 condition is already on target.
let w = warn(current.map(r => Object.assign({}, r)), current);
is('empty diff: NOT reported as copy-caused', !!find(w, 'finished_before_predecessor', 4), false);
is('empty diff: reported as already-on-target', !!find(w, 'finished_before_predecessor_existing', 4), true);
is('empty diff: existing item carries already_on_target', (find(w, 'finished_before_predecessor_existing', 4) || {}).already_on_target, true);

// (2) COPY ADDS an edge: proposed gives finished task 6 a NEW pred 2 (not finished) → copy-caused.
const proposedAdds = [
  { bt_num:2, name:'Pred',  status:'not_started', predecessors:[] },
  { bt_num:4, name:'Clearing', status:'finished', predecessors:[2] },
  { bt_num:6, name:'Later', status:'finished', predecessors:[4,2] },   // 6 now finished + depends on 2 (new)
];
w = warn(proposedAdds, current);
is('added edge (6<-2): reported as copy-caused', !!find(w, 'finished_before_predecessor', 6), true);
is('unchanged edge (4<-2): still only existing', !!find(w, 'finished_before_predecessor', 4), false);

// (3) predecessor finished → no warning at all.
w = warn([
  { bt_num:2, name:'Pred', status:'finished', predecessors:[] },
  { bt_num:4, name:'Clearing', status:'finished', predecessors:[2] },
], [{ bt_num:2, predecessors:[] }, { bt_num:4, predecessors:[2] }]);
is('finished predecessor: no warnings', w.length, 0);

// (4) unfinished dependent → never warns (only finished tasks are out-of-sequence).
w = warn([
  { bt_num:2, name:'Pred', status:'not_started', predecessors:[] },
  { bt_num:4, name:'Clearing', status:'started', predecessors:[2] },
], [{ bt_num:2, predecessors:[] }, { bt_num:4, predecessors:[2] }]);
is('unfinished dependent: no warnings', w.length, 0);

console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASS') + ' (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
