# Offline save + sync — build plan & tracker

Scope: BUILDER/field-app actions only (admin stays online-only). One builder per
lot + admin only edits start/close dates ⇒ builder and admin edits almost never
touch the same data ⇒ **no merge engine**. Model: durable ordered action queue,
replay in (timestamp, seq) order on reconnect, surface anything that can't sync —
NEVER silent-drop.

## Layers (build + verify one at a time)
- **Layer 1 — durable queue** ✅ DONE (`offline-queue.js`). IndexedDB, survives app
  close/phone restart. Proof: `test/offline-queue-browser.js` (persist across reload).
- **Layer 2 — route actions through the queue** ✅ DONE. The 4 builder actions
  (start/finish/note/flag_response) go through `queueAndSync` → enqueue then drain.
  Online = drains instantly, behavior unchanged. Proof: `test/offline-layer2-browser.js`.
  - Routed via 3 code points: `saveTask` (start/finish/undo), `addNote`, `checkPendingResolutions`.
- **Layer 3 — online/offline detection + deferred sync** ✅ DONE. True connectivity
  (`navigator.onLine` + a backend probe that defeats captive portals); offline →
  enqueue + SKIP drain (UI succeeds optimistically); reconnect → drain in order,
  retry, recompute derived, reconcile note ids; `#sync-status` pill (quiet ✓ /
  informative ⏳/⚠offline / loud ⚠failed). `sbCall` split into `sbCallRaw` (quiet,
  network-vs-server error) + the interactive wrapper. Proof: `test/offline-layer3-browser.js`.
- **Layer 4 — offline app LAUNCH (PWA cache)** ✅ DONE. The app now LAUNCHES with no
  signal. Three parts, all in the field app + shared files:
  1. **Service worker** (`sw.js`, `ashland-field-ops-v4`) — REGISTERED at last (it never
     was before). **Network-first** for every same-origin GET (HTML + JS modules):
     online always gets the freshest app, cache is the OFFLINE fallback only — so a
     builder is never trapped on a stale version. Cross-origin (Google Fonts) left to
     the browser → system-font fallback offline. Writes (POST) never intercepted.
     The shell caches on the first SW-CONTROLLED load (i.e. the first online load
     after the SW registers); by the time a builder is at a no-signal jobsite they've
     loaded online before, so the shell is cached.
  2. **Read-through data cache** (`offline-data.js`, IndexedDB `ashland-field-data`).
     New `sbRead(action,payload)` wraps the core reads (getBuilders, getScheduleLots,
     getScheduleLotTasks, getTemplateStageMap, getTaskNotes, getDelayReasons): ONLINE
     fetches live + caches the response; OFFLINE (or a transport failure) serves the
     last cached copy. Only lots the builder OPENED online are cached (can't fabricate
     data they never loaded) — communicated by the staleness indicator.
  3. **Offline login** — a builder who logged in ONLINE at least once can re-launch
     and unlock OFFLINE: on successful online login we persist `{builder, pinHash}`
     (SHA-256) in localStorage, so the PIN is still VERIFIED locally with no signal —
     the gate is preserved, NOT skipped. Startup probes true connectivity; offline +
     a saved session → resume straight to that builder's PIN. Sign-out clears it.
  4. **Staleness indicator** — the offline pill now shows "synced <relative time>" so
     the builder knows how old the data they're looking at is.
  Proofs: `test/offline-coldstart-browser.js` (load online → server SHUT DOWN → fresh
  cold-start page opens from the SW cache, local PIN unlocks, cached lots render) and
  `test/offline-networkfirst-browser.js` (online picks up a redeploy — NOT stale from
  cache; offline serves the last-cached build with the server down). Both are TRUE
  offline (the server is actually stopped — see the sandbox note below).

## ⚠️ PROMOTE / SIGN-OFF NOTES for Layer 4 (Collin, read before we go live)
- **Registering a service worker on the LIVE app is a real, powerful change** (it
  controls the origin and caches the shell). The strategy is network-first so it can
  NEVER trap builders on a stale app, and the cache name is versioned (`-v4`) so the
  activate handler purges old caches. Still: this is the item to promote carefully and
  watch after cutover. `sw.js` is a SHARED file (dev + live identical) — same promote
  discipline as the engine.
- **Offline PIN is verified against a LOCAL SHA-256 hash.** A 4-digit PIN space is
  small, so a determined attacker WITH the unlocked phone + devtools could brute-force
  the stored hash offline (no server lockout offline). Threat model is low (it's the
  builder's own phone; data is construction schedule, not money) and this preserves the
  PIN gate instead of skipping it — but it's a real tradeoff and it's YOUR call to
  sign off before promote. Alternative if you want it tighter: don't persist offline
  login at all (builder must be online to log in), at the cost of no offline cold-start.
- **Test-sandbox finding:** Playwright's `context.setOffline(true)` only flips
  `navigator.onLine` here — it does NOT actually sever localhost traffic. So both Layer 4
  proofs simulate offline by genuinely SHUTTING THE SERVER DOWN (a real connection
  failure), which is a STRONGER test than the emulated flag would have been.

## Known edge (Layer 3, accepted)
- **Cross-lot derived recompute is best-effort for the CURRENT lot.** If a builder
  queues actions on Lot A offline, switches to Lot B, then reconnects, the drain
  replays A's actuals durably, but A's derived `reported_stage` / completion stamp
  catch up only next time Lot A is touched online. Acceptable (one builder per lot;
  actuals are captured durably — only the derived DISPLAY value lags). Same for
  cross-lot note-id reconciliation (reconciles the note in the loaded lot).

## Explicit Layer 3 items (agreed)
- **Recompute derived side-effects on sync.** `saveStage` (reported_stage) and
  `checkCompletionStamp` are DERIVED from task state — left DIRECT in Layer 2, NOT
  queued (queuing would replay a stale computed value). Accepted offline behavior:
  a task finished offline shows finished locally, but the stage code / completion
  stamp don't update until sync. On sync (Layer 3): **recompute + write
  reported_stage and the completion stamp from the replayed task state.**
- **Note id reconciliation.** Offline `addNote` uses the queue action's CLIENT id
  as the local note id; on sync the server assigns the real id → reconcile the
  local `lotNotes` entry (best-effort) so later actions on that note line up.

## Deferred (candidate for offline scope LATER — not now)
- `cycleNoteFlag` (flag a note red/yellow offline) — should eventually survive
  offline too; deferred. Also online-only for now: `toggleConfirm`, `saveEditTask`
  (task edit/est), bulk-push notes, `toggleGate`.

## Invariants
- Client-generated ids (offline, no round-trip). Failed actions retained + surfaced
  (attempts + failed_reason), never dropped. Replay order = (timestamp, seq).
