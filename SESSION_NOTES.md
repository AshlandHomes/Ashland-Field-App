# Session Notes — Ashland Field App

Running log of what shipped and the state at each session's end. Newest first.
(KNOWN_ISSUES.md tracks open follow-ups; this tracks what happened.)

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
