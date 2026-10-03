# Session Notes — Ashland Field App

Running log of what shipped and the state at each session's end. Newest first.
(KNOWN_ISSUES.md tracks open follow-ups; this tracks what happened.)

---

## 🚨 STANDING RULE — THE DATABASE IS SHARED WITH LandIQ 🚨
This Supabase project is SHARED with LandIQ. **Never create, alter, or reference a
LandIQ table.**
- **LandIQ owns:** `app_users`, `tenants`, `companies`, `contacts`, `deal_contacts`,
  `hub_*`, `invites`, `action_log`, `user_table_prefs`.
- **Field app owns:** `field_ops_*`, `sched_*`. **New field-app tables use the
  `field_ops_` prefix.**
- The `dev_` prefix isolates **dev from live ONLY — NOT from LandIQ.** LandIQ has its
  own `dev_`-prefixed tables in this same project.
- **Inventory before any DDL. Use plain `CREATE TABLE` (never `IF NOT EXISTS`) with an
  existence pre-check** that RAISES on collision — `CREATE TABLE IF NOT EXISTS` silently
  ADOPTS an existing (LandIQ) table, which is exactly the 2026-09-26 incident (we ran
  `ALTER … dev_app_users` on LandIQ's user table + added FKs into it; remediated, no
  lasting LandIQ impact).
- **Every new table needs explicit `service_role` GRANTs in the SAME migration — RLS
  bypass is NOT table privilege.** `service_role` has `BYPASSRLS` (skips row policies) but
  still needs `SELECT/INSERT/UPDATE/DELETE` grants, or the app (service key) silently sees
  nothing / can't write. The 2026-09-26 foundation tables shipped without DML grants →
  Add Builder's atomic function rolled back on Dev (2026-09-27). Grant minimal DML per
  table when the table is created; NO anon/authenticated grants (RLS-deny-all stands).

---

## 2026-10-03 — Failed-items sheet: redesign + reason-grouped wording (hotfix, on Dev)

**Hotfix `hotfix/failed-badge-sheet` + Dev mirror — tested on Dev, NOT yet merged to main.**
Finished the "Didn't apply" sheet: the ⚠-badge is gone, the sheet auto-opens after a push that
partially fails and on app open, names the tasks, and uses "Got it" / "Remind me later". This
session rewrote the copy to the approved wording (Collin): per-kind item titles ("Push didn't
fully apply" / "Update didn't save"; multi-item header "Some updates didn't apply"), per-item
layout (subject → "N of M tasks weren't updated:" → task names first-3+"and N more" → plain
"Why:" line → time on its own grey line), reason-specific Why lines, and **mixed reasons grouped**
one block each. `executePushLot` now carries each failed task's server error as `reason` so the
sheet groups by reason. In-step proof held (generate-live(Dev) vs hotfix-live = only 5a/5b lines;
failed-sheet region byte-identical). `offline-queue.js` unchanged (no `?v` bump). Dev commits
`3a963d4` (redesign mirror) + `9307529` (wording); live mirror `d53d37f`.

**AUDIT done — every permanent queue-failure path.** Key finding: the queue has TWO failure
models — `push_lot` honors a `permanent` flag (retain vs retry), but **every other action treats
any server `.error` as permanent** (no transient/retry). Single-task date entries are
pre-validated client-side (same engine, online+offline), so the date-guard only produces a
*queued* permanent failure through a **push** (source dates stamped onto a later-start target —
the CW Lot 1 → Lot 26 case). Full table in the 2026-10-03 chat log. Two gaps recorded in
ENHANCEMENT_BACKLOG as **NEXT (not backlog)**: GAP 2 = silent data loss LIVE today (six write
handlers ignore `r.error`, report success on DB rejection); GAP 1 = non-push actions never retry
a transient failure. **5c/5d of lot-structure push stay ON HOLD until GAPs 1–2 are live.**

---

## 2026-09-27 — LIVE anon lockdown (security) — RESOLVED

**Closed the anon read/write/delete exposure on the live field-app tables.** The shared
project's anon key (shared with LandIQ, public if LandIQ ships it in-browser) + permissive
`secret_all`/`allow_all_*` policies + anon grants let anyone read/write/delete all 23 live
`field_ops_*`/`sched_*` tables directly — including **plaintext PINs** in `field_ops_builders`.

**What changed (live):** ran `sql/2026-09-27_live_anon_lockdown.sql` STEP 1 — for each of the
23 named tables, dropped every policy, `REVOKE ALL FROM anon, authenticated`, `ENABLE RLS`
(deny-all; incl. the 3 previously RLS-off tables `sched_subdivision_lots`,
`sched_subdivision_templates`, `sched_subdivisions`). Live app unaffected — the Netlify
function runs on the **service key** (verified: `keycheck` → `hasServiceRole true`,
`keyStart sb_secret_`), which bypasses RLS and holds full DML.

**Verified:** STEP 2 = 4/4 PASS (policies 0, anon privs 0, authenticated privs 0, rls_disabled 0).
Live smoke test all good (field-app PIN login, lot list, open lot, task-note write, admin
console + builders/lots, and **LandIQ still loads**).

**ROLLBACK:** STEP 0 captured the exact pre-state — **19 policies, 186 anon/authenticated
grants, RLS state for 23 tables (20 on / 3 off)** — as verbatim regenerating SQL. **Collin holds
that STEP 0 output** (authoritative rollback); a hand-written fallback also lives in the SQL file.

**Still open (backlog, SECURITY):** PINs are PLAINTEXT (`pin_hash` stores the raw 4-digit) —
hash server-side; no per-action authorization (function effectively public via the
`/config`-served secret) — step (d) + separation; mark `SUPABASE_SERVICE_ROLE_KEY` +
`API_SHARED_SECRET` secret in Netlify. Next code fix: **B — `getBuilders` PIN leak** (strip
`pin_hash`/`temp_pin` from client responses), staged on Dev, promote pending.

---

## 2026-09-26 — Permission foundation applied on Dev (steps a/b/c) + separation decision

**Step (a) foundation** (`sql/2026-09-26_permission_foundation_fieldops.sql`) applied on Dev,
verified 12/12 PASS. **Step (b) builder backfill** (`sql/2026-09-26_builder_backfill.sql`,
re-run-safe map-first/users-second/link-third, commit `b5ef232`) ran clean on Dev — **9/9 PASS**
(users 7, builder role 6, admin role 1, FK + UNIQUE present, `fk_out_of_namespace` 0).
**Step (c):** online PIN, offline PIN, and Admin login all verified working. No login path changed.

### DECISIONS recorded this session

- **DATABASE SEPARATION — COMMITTED.** LandIQ and the field app / admin console / manager
  module will move to **SEPARATE Supabase projects**. Planned order: **(1)** fix the 3
  BLOCKS-STEP-(d) items on Dev; **(2)** separate as a **pure infra move with ZERO feature
  changes**, verify live; **(3)** promote the permission foundation into the new project.
  (This supersedes "reconcile our auth with LandIQ's in one shared project" — once separated,
  `auth.users` is ours alone and THE SEAM disappears.)
- **Separation VERIFICATION step (not a blocker).** Collin confirms (~99%) LandIQ reads no
  `field_ops_*` / `sched_*` tables. Before cutover: **grep the LandIQ repo for `field_ops_` /
  `sched_` references**, OR smoke-test LandIQ immediately after cutover with rollback ready.
- **LOGIN PLAN.** *Until separation:* named admin accounts use **PIN** (no email/password,
  nothing touching shared `auth.users`). *After separation:* admin console → **username/password**;
  builders and managers (manager view lives in the field app) → **PIN**; **Face ID later**
  (`field_ops_builders.biometric_credential_id` already exists per Collin, but **zero application
  code references it today** — grep-clean; it is a dormant/reserved column).
- **Manager-view storage note.** PIN credentials currently live on `field_ops_builders`, which
  IS the builder login + assignment list. **Managers are not builders**, so PIN storage must move
  to the **user level** (`field_ops_users` or a credentials table) before managers get PINs.
  Short-term, named admin PINs may reuse the existing builders table + `is_admin`.

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
