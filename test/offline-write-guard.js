/*
 * GUARDRAIL (tripwire) — no queued-write action may bypass the durable queue.
 * ---------------------------------------------------------------------------
 * Every simple builder write goes through queueAndSync (Layer 2 + the four silent-loss
 * fixes). A future direct `sbCall('<queued-write>')` would silently drop offline / on a
 * blip again (the addTaskDelay/toggleConfirm class). This test scans the field-app
 * source and FAILS if any of the seven queued-write actions is called via a direct
 * sbCall/sbCallRaw literal OUTSIDE the two sanctioned zones:
 *   - drainQueue        (it REPLAYS queued actions — the sanctioned executor)
 *   - _bpApply / _bpApplyNote  (bulk push — KI-13, replay-with-reads, deferred)
 * Green today; red the moment a fifth direct write is added.
 *
 * Pure source scan (no browser). Spans are line-based off top-level function decls, so
 * it doesn't depend on brace balance inside strings.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

const SRC_PATH = path.resolve(__dirname, '..', 'ashland-stage-update-dev.html');
const src = fs.readFileSync(SRC_PATH, 'utf8');

// the writes that MUST be routed through queueAndSync
const QUEUED_WRITES = ['updateScheduleLotTask','addTaskNote','respondNoteResolution',
  'updateScheduleLotGate','addTaskDelay','updateTaskNote','editLotTask'];
// functions allowed to call them directly
const SANCTIONED = ['drainQueue','_bpApply','_bpApplyNote'];

const lineOf = idx => src.slice(0, idx).split('\n').length;

// top-level function declarations, in order → line-based spans for the sanctioned fns
const decls = [];
const declRe = /^(?:async\s+function|function)\s+([A-Za-z0-9_]+)/gm;
let dm; while ((dm = declRe.exec(src))) decls.push({ name: dm[1], index: dm.index });
function spanOf(name){
  const i = decls.findIndex(d => d.name === name);
  if (i < 0) return null;
  return { start: decls[i].index, end: (i+1 < decls.length) ? decls[i+1].index : src.length };
}
const sanctionedSpans = SANCTIONED.map(n => ({ name:n, span:spanOf(n) }));
const inSanctioned = idx => sanctionedSpans.find(s => s.span && idx >= s.span.start && idx < s.span.end);

// every direct sbCall / sbCallRaw('<literal action>') — NOT queueAndSync({apiAction:...})
const callRe = /sbCall(?:Raw)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;
const violations = [], sanctionedHits = [];
let cm; while ((cm = callRe.exec(src))){
  const action = cm[1];
  if (QUEUED_WRITES.indexOf(action) < 0) continue;         // not a queued-write action → fine
  const zone = inSanctioned(cm.index);
  const hit = { action, line: lineOf(cm.index), zone: zone ? zone.name : null };
  if (zone) sanctionedHits.push(hit); else violations.push(hit);
}

console.log('\n===== Offline write-path guardrail =====\n');
console.log('  guarded write actions: ' + QUEUED_WRITES.join(', '));
console.log('  sanctioned zones: ' + SANCTIONED.join(', ') + (sanctionedSpans.every(s=>s.span)?'  (all found)':'  (MISSING A SPAN!)'));
console.log('  sanctioned direct calls (allowed): ' + JSON.stringify(sanctionedHits));
console.log('  VIOLATIONS (direct queued-write outside a sanctioned zone): ' + JSON.stringify(violations));
console.log('');

check('all sanctioned function spans resolved (detector is live)', sanctionedSpans.every(s => !!s.span));
check('detector actually classifies the known bulk-push direct calls as sanctioned (>=3)', sanctionedHits.length >= 3);
check('NO queued-write action is called directly outside drain + bulk push', violations.length === 0);
if (violations.length){
  console.log('\n  ❌ Route these through queueAndSync (they will silently drop offline / on a blip):');
  violations.forEach(v => console.log('     line ' + v.line + ':  sbCall(\'' + v.action + '\', …)'));
}

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
