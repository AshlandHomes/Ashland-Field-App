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
- **Layer 4 — offline app LAUNCH (PWA cache)** ⏳ NEXT. Layer 3 assumes the app is
  already loaded; Layer 4 makes it launch with no signal (cache the app shell +
  the builder's lot/task data).

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
