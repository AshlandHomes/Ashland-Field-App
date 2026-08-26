/*
 * note-resolution.js — Ashland Field App
 * ---------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for red-flag resolution state. Pure: no DOM, no DB.
 * Works as a browser global (<script src>) and as a Node/CommonJS module
 * (require) via the UMD wrapper below — so the admin console, the field app,
 * the backend endpoints, and the tests all derive/transition state ONE way and
 * can never drift (the same discipline as schedule-engine.js).
 *
 * A "flag" IS a note row in sched_lot_task_notes. The resolution feature adds
 * four columns; the STATE is DERIVED from them (no separate status column):
 *   'none'          not a red flag (flag !== 'red') — no resolution activity shown
 *   'open'          red, no request sent
 *   'asked'         red, request sent, no response yet   (builder has a pending Q)
 *   'confirmed_open'red, builder answered 'still_open'
 *   'resolved'      flag cleared to 'none' by a 'resolved' answer; NOTE ROW KEPT
 *
 * Transition builders return the exact column patch for each action, taking the
 * timestamp as a parameter (pure/testable — no Date.now() inside).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NoteResolution = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VALID_RESPONSES = ['resolved', 'still_open'];

  // Derive the resolution state of a note row from its columns.
  function deriveState(note) {
    if (!note) return 'none';
    if (note.resolution_response === 'resolved') return 'resolved'; // flag cleared, note kept
    if (note.flag !== 'red') return 'none';                          // yellow/none carry no resolution UI
    if (note.resolution_response === 'still_open') return 'confirmed_open';
    if (note.resolution_requested_at) return 'asked';
    return 'open';
  }

  // Is there a pending question the builder still needs to answer?
  function isPending(note) {
    return !!note && note.flag === 'red'
      && !!note.resolution_requested_at
      && (note.resolution_response === null || note.resolution_response === undefined);
  }

  // ADMIN sends (or re-sends) a resolution request. Resets any prior answer so a
  // re-ask puts the note back into 'asked'.
  function buildRequestUpdate(prompt, nowISO) {
    return {
      resolution_requested_at: nowISO,
      resolution_prompt: prompt,
      resolution_response: null,
      resolution_responded_at: null
    };
  }

  // BUILDER answers. 'resolved' clears the flag (keeps the note — permanent-notes
  // rule); 'still_open' leaves the red flag but records the confirmation.
  // 'not sure yet' is NOT a response — the caller simply doesn't invoke this, so
  // the note stays 'asked' and is re-shown next open.
  function buildResponseUpdate(response, nowISO) {
    if (VALID_RESPONSES.indexOf(response) === -1) {
      throw new Error("invalid resolution response: " + response);
    }
    var patch = { resolution_response: response, resolution_responded_at: nowISO };
    if (response === 'resolved') patch.flag = 'none';
    return patch;
  }

  // Human-readable label for a derived state (+ optional date), for both UIs.
  function stateLabel(note) {
    var s = deriveState(note);
    var when = function (iso) {
      if (!iso) return '';
      var d = new Date(iso);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    if (s === 'asked')          return 'Resolution requested ' + when(note.resolution_requested_at);
    if (s === 'confirmed_open') return 'Builder confirmed still open ' + when(note.resolution_responded_at);
    if (s === 'resolved')       return 'Resolved ' + when(note.resolution_responded_at) + ' (note kept)';
    return '';
  }

  return {
    VALID_RESPONSES: VALID_RESPONSES,
    deriveState: deriveState,
    isPending: isPending,
    buildRequestUpdate: buildRequestUpdate,
    buildResponseUpdate: buildResponseUpdate,
    stateLabel: stateLabel
  };
}));
