# Session Notes — Ashland Field App

Running log of what shipped and the state at each session's end. Newest first.
(KNOWN_ISSUES.md tracks open follow-ups; this tracks what happened.)

---

## 2026-09-20 — Single-source STAGE (compute-on-read)

**Live head:** `main = 7d709ff`  ·  **Dev source head:** `Dev` current  ·  both pushed, trees clean.

### 🚨 INVARIANT — DO NOT REINTRODUCE A STAGE WRITER 🚨
`reported_stage` / `true_stage` are **COMPUTE-ON-READ**. They are computed in
`getScheduleLots` (backend) via the shared engine (`ScheduleEngine.computeStage`) — the
SAME computation the in-lot badge uses (`computeStage()` in the field app). **Do NOT add
any code that WRITES `reported_stage`/`true_stage`.** The stored DB columns still exist but
are an **inert fallback only** — nothing maintains them (except the dead/manual
`migrateOldLot` import). If a future task seems to need a stage write, it does NOT — extend
the compute (the engine / `getScheduleLots`), never a stored write. Reintroducing a writer
resurrects the drift bug below.

**WHY:** stage was a stored *copy* of a calculation, kept in step by scattered client
writers. The copy DRIFTED — Lot 10 showed `6` in the lot list but `8` in the in-lot detail
(list read the stored column; detail computed live). Single-source compute-on-read
eliminates the whole drift class *by construction*: list and detail derive from the same
task/gate rows through one engine, so they can't disagree.

**DELETE SET (removed — do not re-add):** `saveStage`, `recomputeAndPersistLotStage`,
`_cachedLot`, the `loadMyLots` first-stage floor mirror, the `bulkUpdateLotTasks` stage-write
(backend), and `executePushLot`'s `reported_stage`/`true_stage` args + stage recompute.

**PRESERVED double-duty (REDUCED/STRIPPED, not deleted — don't mistake for stage-writers):**
- `recomputeDerivedAfterSync` → reduced to *only* firing **completion-stamping**
  (`checkCompletionStamp`) for the open lot. Deleting it whole would silently kill
  completion stamps.
- `executePushLot` → stage-stripped but still does the **gate-push write**
  (`updateScheduleLotGate`), plus task writes, note, delays.

**Fallback = (b) blank-on-error:** if `getScheduleLots` can't fetch a lot's tasks/stage-map,
it BLANKS the stage (`stage_unavailable`), never the stored (drift-prone) value. Field badge
renders a null stage as "—".

**Also shipped:** back-out from a lot detail now refreshes that lot's list badge from the
in-memory state (`refreshCurLotInList` in `backToLots`) — builder sees their own edits
without a manual pull. Works offline, same engine.

**Promote (on top of the durable-push release `7985ce1`):** `getScheduleLots` compute-on-read
+ writer deletion + back-out refresh → merge `7d709ff` (`supabase.js` +
`ashland-stage-update.html`; `admin.html` regenerated identical). Verified on live: drift
gone, back-out shows new stage, readers/export/counts correct, list load **snappy** at prod
scale. (`getScheduleLots` per-lot fetch mirrors the `getAllLotPhases` pattern.)

**Tests added:** `getschedulelots-compute.js`, `completion-stamp-after-sync.js`,
`backout-refreshes-list.js`. Removed obsolete `derived-stage-allsynced.js` (it tested the
deleted writer). Earlier same-day: durable-push `queue-loss-guard.js`, `gate-push-repro.js`
(refocused on gate propagation).

---

## 2026-08-27 — Big session: est-block, KI-2, admin polish, flag-resolution feature

**Live head:** `main = eb34b31`  ·  **Dev source head:** `Dev = 18df808`  ·  both pushed, trees clean.
Shared files (`schedule-engine.js`, `note-resolution.js`) identical Dev↔main; live HTMLs
were byte-verified against a fresh gen from Dev at promote time. Live reflects current Dev.
(Dev-only artifacts — `test/`, `sql/`, `KNOWN_ISSUES.md`, this file — intentionally do not
live on `main`; main carries only generated live files + shared modules + functions.)

### Shipped to LIVE this session (three promotes)
1. **est-block + `earliestStart`** (engine helper; blocks impossible-early est overrides,
   neg-lag-aware). Promote `9c36232`. Field app + engine; cache-bust engine `?v=1→?v=2`,
   sw cache `v1→v2`.
2. **KI-2 single-source completion** (admin reads engine `computeLotSchedule` proj/baseline;
   flat-99 `calcPlannedCompletion` deleted). Promote `8ec194d`. `admin.html` + `supabase.js`.
   KI-2 marked RESOLVED.
3. **Admin polish + flag-resolution feature** (the batch). Promote `eb34b31`, 5 files:
   `admin.html`, `ashland-stage-update.html`, `supabase.js`, `note-resolution.js` (NEW),
   `sw.js` (cache `v2→v3`). Included a **LIVE DB migration**: 4 `resolution_*` columns +
   CHECK + `notify pgrst 'reload schema'` on `sched_lot_task_notes`. Live API-visibility
   confirmed (requestNoteResolution stamped a real timestamp, no stale cache).

   - **Admin polish:** close date under the Closed badge; activity last-update date inline
     under the ✓/⚠ badge (replaced the earlier tooltip); closed lots collapse into a bottom
     group; active lots grouped by subdivision (collapsible, default expanded); pointer-cursor
     fix (`.badge` default, `.badge-sub` help, clickables pointer).
   - **Flag-resolution (two-way loop):** admin sends a canned "Has this been resolved?" on a
     RED flag → builder gets an on-open modal (queue; Yes clears flag + keeps note / No →
     confirmed-open / Not-sure → stays pending). All state via the shared `note-resolution.js`
     (admin + field + backend, no drift). Admin flag list scoped RED-only (yellow = builder's
     own reminder, excluded). Endpoints: `requestNoteResolution`, `respondNoteResolution`,
     `getPendingResolutions`. Sync is load-based (next open / next refresh), not realtime.

### Test suite: 19 files, all green (engine parity, est-block, admin render/grouping,
flag-resolution state machine + both UIs). Non-realtime + swallowed-fetch-errors are by design.

### Corrections owned this session
- Retracted the earlier "interior float is intentional" conclusion — it was dead-end FALSE
  float from missing dependencies (Collin's catch). See KNOWN_ISSUES template dead-end item.
- Let commits pile up locally un-pushed at one point (Collin caught the Dev site not
  rebuilding). Now pushing at each stopping point.

### Open follow-ups (see KNOWN_ISSUES.md)
- **Template dead-end reconnection** — ~37 Slab work tasks can't reach Closing → false float,
  optimistically-early completion. Fix by REBUILDING the template (data fix, no deploy). Plus a
  proposed `validateSchedule` rule: "every non-terminal work task must reach the final task."
- **KI-9** — today-floor + active/inert override flag + delay rule (all reuse `earliestStart`).
- **KI-10** — stale-task "was due" date computed outside the engine (low; decide with KI-9).
- **KI-11** — no distinct "actual closed-on" date (`scheduled_close_date` overloaded).
- **KI-12** — optional: fold canceled lots into the closed group too.
