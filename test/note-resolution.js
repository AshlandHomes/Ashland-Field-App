/*
 * test/note-resolution.js — the red-flag resolution STATE MACHINE, proving the
 * one shared source (note-resolution.js) that the admin, field app, and the
 * backend endpoints all use. Pure logic (no DB): API-visibility is proven live
 * by the first endpoint test on Dev; this proves the transitions are correct.
 */
'use strict';
const NR = require('../note-resolution.js');

const G='\x1b[32m',R='\x1b[31m',X='\x1b[0m',ok=b=>b?G+'PASS'+X:R+'FAIL'+X;
let allPass = true;
const check = (label, cond) => { allPass = allPass && cond; console.log('   [' + ok(cond) + '] ' + label); };

const T1 = '2026-08-21T10:00:00.000Z';   // request time
const T2 = '2026-08-22T14:30:00.000Z';   // response time
// apply a column patch to a note exactly like the endpoint PATCH does
const apply = (note, patch) => Object.assign({}, note, patch);

console.log('\n===== note-resolution state machine =====\n');

// ── deriveState for each column combination ──
check("red + no request -> 'open'",
  NR.deriveState({ flag:'red' }) === 'open');
check("red + requested + no response -> 'asked'",
  NR.deriveState({ flag:'red', resolution_requested_at:T1 }) === 'asked');
check("red + response 'still_open' -> 'confirmed_open'",
  NR.deriveState({ flag:'red', resolution_requested_at:T1, resolution_response:'still_open' }) === 'confirmed_open');
check("response 'resolved' (flag cleared) -> 'resolved'",
  NR.deriveState({ flag:'none', resolution_requested_at:T1, resolution_response:'resolved' }) === 'resolved');
check("yellow flag -> 'none' (no resolution UI)",
  NR.deriveState({ flag:'yellow' }) === 'none');
check("plain note (flag none, no activity) -> 'none'",
  NR.deriveState({ flag:'none' }) === 'none');

// ── full transition walk on ONE note (permanent-notes: text/id never change) ──
const original = { id:'n1', bt_num:84, note:'Leak at rear window', flag:'red',
  author:'Marisa', created_at:'2026-08-01T09:00:00.000Z',
  resolution_requested_at:null, resolution_prompt:null, resolution_response:null, resolution_responded_at:null };

// 1) open -> admin requests
const asked = apply(original, NR.buildRequestUpdate('Has this been resolved?', T1));
check("open -> request => state 'asked'", NR.deriveState(asked) === 'asked');
check("request stores the prompt + requested_at, response cleared",
  asked.resolution_prompt === 'Has this been resolved?' && asked.resolution_requested_at === T1 && asked.resolution_response === null);
check("asked note is 'pending' for the builder", NR.isPending(asked) === true);

// 2a) asked -> builder answers RESOLVED (flag clears, note KEPT)
const resolved = apply(asked, NR.buildResponseUpdate('resolved', T2));
check("respond 'resolved' => state 'resolved'", NR.deriveState(resolved) === 'resolved');
check("resolved clears the flag to 'none'", resolved.flag === 'none');
check("resolved keeps the NOTE row intact (text, id, author, created_at)",
  resolved.note === original.note && resolved.id === original.id && resolved.author === original.author && resolved.created_at === original.created_at);
check("resolved note is NOT pending anymore", NR.isPending(resolved) === false);

// 2b) asked -> builder answers STILL_OPEN (flag stays red)
const stillOpen = apply(asked, NR.buildResponseUpdate('still_open', T2));
check("respond 'still_open' => state 'confirmed_open'", NR.deriveState(stillOpen) === 'confirmed_open');
check("still_open leaves the red flag intact", stillOpen.flag === 'red');
check("still_open is NOT pending (answered)", NR.isPending(stillOpen) === false);

// 3) confirmed_open -> admin RE-asks => back to 'asked' (response reset)
const reAsked = apply(stillOpen, NR.buildRequestUpdate('Please update — what\'s the current status?', T2));
check("confirmed_open -> re-request => state 'asked' (response reset to null)",
  NR.deriveState(reAsked) === 'asked' && reAsked.resolution_response === null);
check("re-asked note is pending again", NR.isPending(reAsked) === true);

// ── invalid response rejected (matches the backend 400 + the DB CHECK) ──
let threw = false; try { NR.buildResponseUpdate('not_sure', T2); } catch(e){ threw = true; }
check("buildResponseUpdate('not_sure') throws — 'not sure yet' is NOT a response", threw);
check("VALID_RESPONSES is exactly ['resolved','still_open']",
  JSON.stringify(NR.VALID_RESPONSES) === JSON.stringify(['resolved','still_open']));

// ── labels (both UIs render these) ──
check("stateLabel(asked) mentions 'requested'", /requested/i.test(NR.stateLabel(asked)));
check("stateLabel(confirmed_open) says 'still open'", /still open/i.test(NR.stateLabel(stillOpen)));
check("stateLabel(resolved) says 'note kept'", /note kept/i.test(NR.stateLabel(resolved)));

console.log('\n===== ' + (allPass ? G+'ALL PASS' : R+'FAIL') + X + ' =====');
process.exit(allPass ? 0 : 1);
