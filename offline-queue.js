/*
 * offline-queue.js — Ashland Field App (OFFLINE SAVE + SYNC, Layer 1)
 * ---------------------------------------------------------------------------
 * A DURABLE, ordered local action queue for BUILDER/field-app actions
 * (start/finish task, add note, answer flag-resolution). This layer ONLY
 * persists actions; it does NOT talk to the network, detect online/offline, or
 * touch any builder action wiring — those are Layers 2–4.
 *
 * Storage: IndexedDB (survives app close AND phone restart — builders work all
 * day offline, so in-memory / sessionStorage will not do; localStorage is
 * synchronous, ~5MB, string-only, and blocks the UI — wrong tool). One DB
 * `ashland-field-offline`, one store `action_queue`, keyed by an autoIncrement
 * `seq` (monotonic insertion order = deterministic tie-break for equal
 * timestamps), with indexes on `id` (client-generated, unique), `status`, and
 * `timestamp`.
 *
 * Replay order (for Layer 3): timestamp ASC, then seq ASC. Timestamp = when the
 * builder acted (their intent, and what gets written as actual_start/finish);
 * seq is the true causal insertion order and the tie-break if two actions share
 * a timestamp (or a phone clock misbehaves).
 *
 * Failure model (Collin's rule): a failed action is RETAINED with status
 * 'failed' + a reason and surfaced (getAll) — NEVER silently dropped. Retry
 * policy is Layer 3; this layer just records the state.
 *
 * Browser module (needs IndexedDB). UMD wrapper for consistency/requireability.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OfflineQueue = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'ashland-field-offline';
  var DB_VERSION = 1;
  var STORE = 'action_queue';
  var VALID_STATUS = ['pending', 'synced', 'failed'];
  var _dbPromise = null;

  function nowISO() { return new Date().toISOString(); }

  function genId() {
    // CLIENT-generated (no server round-trip — the action is created offline).
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
          os.createIndex('id', 'id', { unique: true });
          os.createIndex('status', 'status', { unique: false });
          os.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }

  function store(mode) {
    return openDB().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }

  function reqP(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // replay order: timestamp asc, then seq asc (deterministic).
  function sortForReplay(rows) {
    return rows.slice().sort(function (a, b) {
      if (a.timestamp < b.timestamp) return -1;
      if (a.timestamp > b.timestamp) return 1;
      return (a.seq || 0) - (b.seq || 0);
    });
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────

  // enqueue a NEW builder action. Caller supplies the meaningful fields:
  //   { type, apiAction, target, payload, timestamp?, builder }
  // We stamp id (if absent), status='pending', attempts=0, and audit times.
  // seq is assigned by the store (autoIncrement). Resolves to the stored action.
  function enqueue(action) {
    var a = {};
    for (var k in action) if (Object.prototype.hasOwnProperty.call(action, k)) a[k] = action[k];
    if (!a.id) a.id = genId();
    if (!a.timestamp) a.timestamp = nowISO();
    a.status = 'pending';
    a.attempts = 0;
    a.failed_reason = null;
    a.enqueued_at = nowISO();
    return store('readwrite').then(function (os) {
      return reqP(os.add(a)).then(function (seq) { a.seq = seq; return a; });
    });
  }

  function getAll() {
    return store('readonly').then(function (os) {
      return reqP(os.getAll()).then(function (rows) { return sortForReplay(rows || []); });
    });
  }

  function getPending() {
    return getAll().then(function (rows) {
      return rows.filter(function (r) { return r.status === 'pending'; });
    });
  }

  // update one action (found by client id) inside a single readwrite tx (atomic).
  function updateById(id, mutate) {
    return store('readwrite').then(function (os) {
      return reqP(os.index('id').get(id)).then(function (row) {
        if (!row) throw new Error('offline-queue: action not found: ' + id);
        mutate(row);
        return reqP(os.put(row)).then(function () { return row; });
      });
    });
  }

  // Rewrite the NOTE id inside every still-PENDING action, from a client id (used
  // for a note created offline) to its real server id, once the note's addTaskNote
  // has synced. Without this, a flag/update queued against an offline-created note
  // would replay with an id the server never issued and fail. Atomic (one tx:
  // getAll then put the hits, so the tx stays alive to commit). Returns the count.
  function remapNoteId(fromId, toId) {
    if (fromId === toId || fromId == null) return Promise.resolve(0);
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var os = tx.objectStore(STORE);
        var patched = 0;
        os.getAll().onsuccess = function (e) {
          (e.target.result || []).forEach(function (r) {
            if (r.status !== 'pending') return;
            var hit = false;
            if (r.payload && r.payload.id === fromId) { r.payload.id = toId; hit = true; }
            if (r.target && r.target.note_id === fromId) { r.target.note_id = toId; hit = true; }
            if (hit) { patched++; os.put(r); }
          });
        };
        tx.oncomplete = function () { resolve(patched); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function markSynced(id) {
    return updateById(id, function (r) { r.status = 'synced'; r.synced_at = nowISO(); r.failed_reason = null; });
  }

  function markFailed(id, reason, extra) {
    // RETAIN + surface; never drop. Bumps attempts so Layer 3 can back off. `extra` (optional)
    // stows structured detail on the row (e.g. failed_tasks) for a later readable surface.
    return updateById(id, function (r) {
      r.status = 'failed'; r.failed_reason = reason || null;
      if (extra && typeof extra === 'object') {
        for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k]; }
      }
      r.attempts = (r.attempts || 0) + 1; r.failed_at = nowISO();
    });
  }

  // A TRANSIENT failure (server unreachable / 5xx / auth blip / untagged error): keep the action
  // PENDING so it retries — NEVER dropped — but bump attempts + record the reason + time, so the
  // UI can surface a "still saving" notice once it has been stuck for a few passes. Status stays
  // 'pending' (it remains in getPending() and keeps retrying).
  function markTransient(id, reason) {
    return updateById(id, function (r) {
      r.attempts = (r.attempts || 0) + 1;
      r.last_transient_reason = reason || null;
      r.last_attempt_at = nowISO();
    });
  }

  // DISMISS a failed item: acknowledge it so the badge stops counting it — NEVER delete.
  // The row is kept (status stays 'failed') for audit.
  function markAcknowledged(id) {
    return updateById(id, function (r) { r.acknowledged_at = nowISO(); });
  }

  // counts for the sync-status indicator (Layer 2+ weaves this through the UI).
  // transientStuck = pending actions that have failed transiently >= STUCK_ATTEMPTS times
  // (server reachable but rejecting, or repeatedly unreachable) — surfaced, never silent.
  var STUCK_ATTEMPTS = 3;
  function summary() {
    return getAll().then(function (rows) {
      var s = { pending: 0, synced: 0, failed: 0, failedUnack: 0, transientStuck: 0, total: rows.length };
      rows.forEach(function (r) {
        if (s[r.status] != null) s[r.status]++;
        if (r.status === 'failed' && !r.acknowledged_at) s.failedUnack++;   // dismissed failures excluded
        if (r.status === 'pending' && (r.attempts || 0) >= STUCK_ATTEMPTS) s.transientStuck++;
      });
      return s;
    });
  }

  // test/maintenance helper — clears the whole store.
  function _clearAll() {
    return store('readwrite').then(function (os) { return reqP(os.clear()); });
  }

  return {
    enqueue: enqueue,
    getPending: getPending,
    getAll: getAll,
    markSynced: markSynced,
    markFailed: markFailed,
    markTransient: markTransient,
    markAcknowledged: markAcknowledged,
    remapNoteId: remapNoteId,
    summary: summary,
    STUCK_ATTEMPTS: STUCK_ATTEMPTS,
    VALID_STATUS: VALID_STATUS,
    _clearAll: _clearAll,
    _dbName: DB_NAME,
    _store: STORE
  };
}));
