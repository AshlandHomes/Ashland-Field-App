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

- **Layer 4b — background TERRITORY prefetch** ✅ DONE. Per-lot-on-open caching didn't
  match how builders work (they own whole subdivisions, 50+ active lots, can't pre-open
  each). Now: on online load the lot LIST loads first (app usable in seconds), then a
  background filler caches EVERY active lot's tasks + notes so the whole territory is
  offline — without blocking the UI or hammering the backend.
  - **Set:** `builder_name===me && reported_stage>=1.1 && status!=='closed'` (active only;
    a builder's "subdivisions" are just their lots grouped by `community` — assignment is
    by builder_name, there's no separate subdivision table).
  - **How:** `prefetchOffline()` — sequential + throttled (200ms/lot), recently-active
    first (sort by `updated_at` desc, so if signal drops the lots worked TODAY are already
    cached), template stage-maps deduped. Silent background reads (`_prefetchRead`, never
    alerts). Reuses the SAME offline-data.js cache as the on-open path — no new store.
  - **Refresh:** missing/stale only (a lot re-pulls at most ~once / 8h via `cached_at`);
    pull-to-refresh (↻) forces a full re-fill; opening a lot always refreshes it.
  - **Offline-aware:** pauses if signal drops mid-fill, resumes on reconnect (syncQueue).
  - **Progress pill** (second pill, under the sync pill): `⏳ Caching 23/50 offline` →
    `✓ 50 lots ready offline` (fades) → honest `⚠ 23/50 lots cached` if signal drops mid-fill.
  - Proof: `test/offline-prefetch-browser.js` — 50 lots, app usable immediately, fill runs
    in the background w/ progress, recently-active-first order, ALL 50 cached (none opened
    by hand), closed lot skipped, then server SHUT DOWN and a never-opened lot opens offline.
- **Layer 4c — UTILITY GATES offline** ✅ DONE. `toggleGate` is a SIMPLE write (a boolean
  on an existing server gate row — no live reads), so it now routes through `queueAndSync`
  exactly like start/finish: flips locally offline, enqueues, drains on reconnect; the
  derived `reported_stage` (saveStage) recomputes post-drain (`recomputeDerivedAfterSync`
  extended to fire on `updateScheduleLotGate`). Proof: `test/offline-gate-browser.js`.

## Direct-write inventory (audit — which builder writes still bypass the queue)
| Write (function) | Endpoint | Type | Needs offline? | Status |
|---|---|---|---|---|
| `toggleGate` | updateScheduleLotGate | SIMPLE (+derived) | HIGH (field) | ✅ ROUTED (4c) |
| start/finish/undo (`saveTask`) | updateScheduleLotTask | SIMPLE (+derived) | core | ✅ routed (L2) |
| note add (`addNote`) | addTaskNote | SIMPLE | core | ✅ routed (L2) |
| flag response (`checkPendingResolutions`) | respondNoteResolution | SIMPLE | core | ✅ routed (L2) |
| delay reason on finish (`finishTask` → addTaskDelay) | addTaskDelay | SIMPLE (client-computed) | HIGH — rides on the offline `finish`; today it's silently DROPPED offline | ⏳ DECIDE (recommend next) |
| vendor confirm (`toggleConfirm`) | updateScheduleLotTask(vendor_confirmed) | SIMPLE | medium (field) | ⏳ DECIDE (easy) |
| note flag cycle (`cycleNoteFlag`) | updateTaskNote(flag) | SIMPLE (client-id wrinkle for notes made offline) | medium | ⏳ DECIDE |
| task edit (`saveEditTask`) | editLotTask + updateScheduleLotTask | 2 writes, structural (client-validated, no server reads) | LOW (planning, not field) | ⏳ DEFER |
| bulk push (`_bpApply`/`_bpApplyNote`) | bulkUpdateLotTasks/addTaskNote | REPLAY-WITH-READS | — | ⏳ KI-13 (own pass) |
| `saveStage` / `checkCompletionStamp` | updateScheduleLot / stampLotComplete | DERIVED (internal, auto) | — | already post-drain |

**Recommended next (Collin to decide):** route `addTaskDelay` (the delay reason on
finish) — it's simple and rides on the already-offline `finish`, but is silently dropped
offline today, so it's a live data-integrity gap on a core action. `toggleConfirm` is a
trivial add. `saveEditTask` is planning (low field need) → defer. Bulk push = KI-13.

## ⚠️ PROMOTE / SIGN-OFF NOTES for Layer 4 (Collin, read before we go live)
- **Registering a service worker on the LIVE app is a real, powerful change** (it
  controls the origin and caches the shell). ✅ APPROVED to proceed (Collin) — with the
  careful-promote discipline + a real-device test on Dev FIRST. The strategy is
  network-first so it can NEVER trap builders on a stale app, and the cache name is
  versioned (`-v4`) so the activate handler purges old caches. Still the item to promote
  deliberately and watch after cutover. `sw.js` is a SHARED file (dev + live identical)
  — same promote discipline as the engine.
- **Real-device test on Dev BEFORE promote:** see `DEVICE_TEST_offline.md` (airplane-mode
  cold-start + offline actions + reconnect drain on Collin's actual phone). "Passes in the
  harness" ≠ "works in-hand in airplane mode" — this ships to builders.
- **Offline PIN is verified against a LOCAL SHA-256 hash.** ✅ APPROVED (Collin) — KEEP
  as built. Reasoning: threat model is low (builder's OWN phone, gates SCHEDULE data
  not money/PII, needs physical possession of the unlocked phone + devtools + motive);
  the tighter alternative (no persisted offline login) DESTROYS the core feature (a
  builder at a dead-zone lot couldn't open the app at all). The offline PIN still KEEPS
  a gate (verifies locally, doesn't skip auth) — it just can't rate-limit offline.
  **Future hardening (logged, NOT now):** 6-digit PIN, and/or a local too-many-attempts
  lockout for the offline path. Polish, revisit later.
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
