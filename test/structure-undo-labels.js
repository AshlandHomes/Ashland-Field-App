'use strict';
// UNDO preview has NO source lot, so engine warnings on the restored graph must be labelled
// already_on_target (when the CURRENT target has them too) — NOT pre_existing_in_source,
// which would imply a source/new condition that doesn't exist. PUSH keeps pre_existing_in_source.
const api = require('../netlify/functions/supabase.js');
const build = api._buildStructurePreview;

let pass = 0, fail = 0;
function is(name, got, want) {
  const ok = got === want; ok ? pass++ : fail++;
  console.log((ok ? '  ok  - ' : '  FAIL- ') + name + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}

// A lot with TWO sources (tasks 2 and 3 have no predecessor) → validateSchedule flags
// multiple_sources. No structural change proposed (structByBt mirrors current), so it's the
// pure "already present" case.
const rows = [
  { bt_num:2, name:'A', status:'not_started', predecessors:[], lag:0, duration:1, phase_name:'P', phase_order:1, task_order:1 },
  { bt_num:3, name:'B', status:'not_started', predecessors:[], lag:0, duration:1, phase_name:'P', phase_order:1, task_order:2 },
  { bt_num:4, name:'C', status:'not_started', predecessors:[2,3], lag:0, duration:1, phase_name:'P', phase_order:1, task_order:3 },
];
const byBt = {}; rows.forEach(r => byBt[r.bt_num] = r);
const tgt = { rows: rows, start: null };

// UNDO (srcRowsForLabel = null): multiple_sources must be already_on_target:true, and must
// NOT carry pre_existing_in_source.
let p = build(tgt, byBt, null);
let ms = p.warnings.find(w => w.rule === 'multiple_sources');
is('undo: multiple_sources present', !!ms, true);
is('undo: labelled already_on_target=true', ms && ms.already_on_target, true);
is('undo: does NOT carry pre_existing_in_source', ms && ('pre_existing_in_source' in ms), false);

// PUSH (srcRowsForLabel = source that ALSO has the two sources): pre_existing_in_source:true.
p = build(tgt, byBt, rows);
ms = p.warnings.find(w => w.rule === 'multiple_sources');
is('push: multiple_sources labelled pre_existing_in_source=true', ms && ms.pre_existing_in_source, true);
is('push: does NOT carry already_on_target', ms && ('already_on_target' in ms), false);

console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASS') + ' (' + pass + ' passed)');
process.exit(fail ? 1 : 0);
