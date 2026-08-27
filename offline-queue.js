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

  function markSynced(id) {
    return updateById(id, function (r) { r.status = 'synced'; r.synced_at = nowISO(); r.failed_reason = null; });
  }

  function markFailed(id, reason) {
    // RETAIN + surface; never drop. Bumps attempts so Layer 3 can back off.
    return updateById(id, function (r) {
      r.status = 'failed'; r.failed_reason = reason || null;
      r.attempts = (r.attempts || 0) + 1; r.failed_at = nowISO();
    });
  }

  // counts for the sync-status indicator (Layer 2+ weaves this through the UI).
  function summary() {
    return getAll().then(function (rows) {
      var s = { pending: 0, synced: 0, failed: 0, total: rows.length };
      rows.forEach(function (r) { if (s[r.status] != null) s[r.status]++; });
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
    summary: summary,
    VALID_STATUS: VALID_STATUS,
    _clearAll: _clearAll,
    _dbName: DB_NAME,
    _store: STORE
  };
}));
