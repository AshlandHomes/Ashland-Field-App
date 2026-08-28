/*
 * offline-data.js — Ashland Field App (OFFLINE LAUNCH, Layer 4)
 * ---------------------------------------------------------------------------
 * Read-through DATA CACHE so the builder sees their lots/tasks/notes with no
 * signal — from the LAST online load. On each successful ONLINE read we cache
 * the response (keyed by action + payload); OFFLINE we serve that cache. Also
 * records `last_synced` for the staleness indicator.
 *
 * This is the DATA cache (what the app read). The ACTION queue (what the builder
 * did) is offline-queue.js — separate concerns, separate IndexedDB DBs. Pure
 * storage: no network here (the field app's sbRead decides online vs offline).
 * UMD wrapper for browser global + Node require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OfflineData = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'ashland-field-data';
  var DB_VERSION = 1;
  var READS = 'reads';   // { key, response, cached_at }
  var META = 'meta';     // { k, v }
  var _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(READS)) db.createObjectStore(READS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }

  function keyOf(action, payload) { return action + '|' + JSON.stringify(payload || {}); }
  function nowISO() { return new Date().toISOString(); }

  // Cache one online read response + stamp last_synced (both in one transaction).
  function put(action, payload, response) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([READS, META], 'readwrite');
        tx.objectStore(READS).put({ key: keyOf(action, payload), response: response, cached_at: nowISO() });
        tx.objectStore(META).put({ k: 'last_synced', v: nowISO() });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Serve a cached read (or null if never cached).
  function get(action, payload) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(READS, 'readonly').objectStore(READS).get(keyOf(action, payload));
        r.onsuccess = function () { resolve(r.result ? r.result.response : null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  // Like get(), but returns { response, cached_at } so callers can judge staleness
  // (used by the background territory prefetch to skip already-fresh lots).
  function getWithMeta(action, payload) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(READS, 'readonly').objectStore(READS).get(keyOf(action, payload));
        r.onsuccess = function () { resolve(r.result ? { response: r.result.response, cached_at: r.result.cached_at } : null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function lastSynced() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var r = db.transaction(META, 'readonly').objectStore(META).get('last_synced');
        r.onsuccess = function () { resolve(r.result ? r.result.v : null); };
        r.onerror = function () { resolve(null); };
      });
    });
  }

  function _clearAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([READS, META], 'readwrite');
        tx.objectStore(READS).clear(); tx.objectStore(META).clear();
        tx.oncomplete = function () { resolve(); }; tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  return { put: put, get: get, getWithMeta: getWithMeta, lastSynced: lastSynced, _clearAll: _clearAll, _dbName: DB_NAME };
}));
