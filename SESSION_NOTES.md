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

## 2026-10-10 — est_start_date carried in the structure copy — SHIPPED to live (merge `75b0f34`)

**What:** the whole-lot "Also copy schedule changes" now also copies `est_start_date`
(Option B — absolute date, source→target by `bt_num`), alongside the existing structural
columns. A copied est that would land before the target's **construction-start floor** OR before
the task's **predecessor-earliest start** (engine `earliestStart`, predecessor-driven) is
**skipped per task** — that task keeps its own est — and shown in the preview as
"Est. start kept (not copied)". Everything else in the copy still applies. Undo restores est;
est is now in the undo lock-in fingerprint (so any pre-deploy copy's Undo hides — acceptable).

**Why skip-per-task (not block-the-whole-copy):** one misaligned absolute est must not void a
valid structure copy of the whole lot. The handler validates each copied est server-side
(the apply RPC bypasses `checkDateEntry`) and the skip set is passed to the RPC so
**preview == what's written** — the server never shows a change it won't make.

**Live SQL (applied & verified 2026-10-10, 5/5 PASS):** `ADD COLUMN est_start_date` on
`field_ops_lot_structure_snapshot_tasks`; dropped the 5-arg `field_ops_apply_lot_structure`
and created the 6-arg (adds `p_skip_est_bts integer[]`), EXECUTE service_role-only.
**DROP-first** (never 6-arg alongside 5-arg): with one function present the pre-merge
5-named-arg calls resolve to the 6-arg via the `p_skip_est_bts` default; both present would be
an ambiguous overload (PostgreSQL "could not choose the best candidate" → PGRST203) and break
every live copy/undo during the window. TABLE_PREFIX on live confirmed empty.

**Code (promote off `main`, 2 live files):** `netlify/functions/supabase.js` — `STRUCT_COLS`
+`est_start_date`; `_structFingerprint` +est; new `_estSkips`/`_applyEstSkips`; preview/apply
handlers compute the skip set (apply passes `p_skip_est_bts`). `ashland-stage-update.html`
(regenerated from `-dev`) — `_bpHumanChange` est line + the skip section. `upsertBuilderRecord`
kept as main's on_conflict handler — the create-builder RPC / permission-foundation work stays
OUT of live. Engine / admin.html / offline-queue.js / sw.js untouched → **no cache `?v` bump**.
In-step proof: `generate-live(Dev -dev)` byte-identical to the shipped live HTML;
`diff(hotfix supabase.js, Dev)` == only the `upsertBuilderRecord` hunk.

**Dev verified before promote (commit `083e82c`):** T1 preview showed the est copy line; T3
apply wrote it; T4 undo cleared it; T5 edit-after-copy hid Undo (fingerprint incl. est). T2
(skip path) covered by the server-side unit check.

---

## 2026-10-06 — Stage is server-only on the phone — SHIPPED to live (merge `1b160d5`)

**Live bug:** CW Lot 25 flipped 4.9 (list) ↔ 5.0 (lot screen) — the phone computed stage
client-side from not-yet-synced local state, and `refreshCurLotInList` wrote that client value
into the lot-list row on back-out. Read-only blast-radius snippet on live = **0 mismatches of 41
lots** (server stage is correct, Lot 25 included) → no server/gate-data bug; purely the phone's
second calculation.

**Fix (field app, display-only — stage calculated in ONE place, the server):**
- `renderSchedule` renders the badge from the server fields on the lot (`reported_stage`,
  `true_stage`, `hold_gate_name`, `no_stages`) — no `computeStage()`.
- `refreshCurLotInList` removed (it computed + wrote the client value); `backToLots` just renders
  the list, which reads the server value off the myLots row.
- `_refreshLotStageBadge()` after each online sync re-fetches the server stage onto `curLot` (=
  the myLots row) and re-renders, so badge + list update without a manual pull-to-refresh.
- Unsynced change → keep the last server value with a small "⏳ pending sync" mark (offline, or a
  queued-pending action for the lot). `computeStage()` removed entirely; stage legend untouched.
- Admin already server-only (displays `reported_stage`); no change.

Ship: hotfix off `origin/main` + Dev mirror + in-step proof; engine untouched (no `?v` bump),
field-app HTML only. Backlog (not built): completion/projected date is still dual-computed
(field app vs admin `computeProjected`); hold gates read from two sources — see ENHANCEMENT_BACKLOG.

---

## 2026-10-05 — Schedule-push LIVE migrations applied (code promote next)

Both LIVE SQL migrations for the schedule-push feature are applied + verified on the live
Supabase project (field_ops_* / no dev_ prefix):
- **`field_ops_lot_structure_snapshots` + `_snapshot_tasks` + `field_ops_apply_lot_structure(...)`**
  (`sql/2026-10-02_lot_structure_push.sql` LIVE section) — 9/9 PASS. RLS deny-all; service_role
  SELECT+INSERT only on the immutable snapshot tables; EXECUTE service_role-only on the RPC.
- **`field_ops_lot_structure_fingerprints`** (`sql/2026-10-04_lot_structure_fingerprint.sql`
  LIVE section) — 5/5 PASS. INSERT-ONLY companion, UNIQUE(snapshot_id), FK ON DELETE CASCADE,
  RLS deny-all, service_role SELECT+INSERT only.

SQL runs BEFORE the code (so the RPC + tables exist the moment the code goes live). NEXT: the
4-file code promote via `hotfix/schedule-push-promote` (regenerated field-app HTML incl. engine
?v=4, surgical supabase.js keeping main's upsertBuilderRecord, whole schedule-engine.js delta,
one-line admin.html engine ?v bump) — permission-foundation work stays OUT.

---

## 2026-10-04 — SHIPPED to live: GAP 1+2 queue integrity (server never lies)

**Merged to main `ec6ccda` (--no-ff, hotfix/queue-integrity); client + function only, no DB
change; offline-queue.js ?v=3; TABLE_PREFIX empty on live.**

- **GAP 2 (silent data loss, was live):** every write handler in `supabase.js` now surfaces
  `r.error` via a new `dbFail(r)` instead of returning 200+null on a DB/RLS/constraint
  rejection; single-record PATCH/DELETE treat a 0-row match as a PERMANENT "not found"
  (`notFound`/`_zeroRows`). DELETEs stay idempotent but surface real errors. Admin multi-step
  builders guard their primary writes; secondary child writes + bookkeeping touches stay
  best-effort by design (deeper transactional rollback = separate future item).
- **GAP 1 (classification):** `drainQueue` uses ONE branch for all kinds. permanent = 400/409/422
  + date-guard + not-found + unknown-action, tagged by the server OR by `sbCallRaw` from the HTTP
  status when the server didn't tag it (so untagged/missing-field 400s are permanent, never a
  retry loop). Everything else (5xx/auth/404/network) is transient → stays pending, retries.
  **Per-lot ordering barrier:** once an action on a lot is left pending this pass, all later
  actions on that lot are held (before any attempt — they don't accrue their own attempts), so a
  retry can never land after and overwrite a newer same-lot edit. A transient action stuck ≥3
  attempts surfaces "Still saving — can't reach the server. It'll keep trying." (blue, no button,
  self-clears on sync).
- Verified on Dev: non-existent task_id → HTTP 409 permanent "not found" (no silent null);
  normal finish + normal whole-lot push → clean success, no false sheet.
- **Deferred Dev tests (on the backlog, not blocking):** online transient→"Still saving" path;
  the per-lot ordering/no-overwrite barrier.

**Next:** resume lot-structure push — 5b re-test, then 5c (confirm/apply + schedule-copy summary)
and 5d (undo button + preview + apply).

---

## 2026-10-04 — SHIPPED to live: failed-items sheet + PIN-leak fix

Two hotfixes merged to main (--no-ff) and confirmed Published on
**ashland-field-ops.netlify.app** (live is ashland-field-ops, NOT myvera-app;
Vera/tandem-health untouched):

- **Failed-items sheet** — merge **`56284d9`** (hotfix/failed-badge-sheet). The
  ⚠-badge is gone; the "Didn't apply" sheet auto-opens after a partially-failed
  push and on app open, names the failed tasks, groups them by reason with plain
  "Why:" lines, shows real "N of M" counts, uses lot_number verbatim (no double
  "Lot"), handles legacy push rows (counts + "names not recorded"), and offers
  "Got it"/"Remind me later". Client-side only (IndexedDB); no DB change.
- **PIN-leak fix** — merge **`9ed6f10`** (hotfix/pin-leak). The server never
  returns a PIN: getBuilders strips pin_hash/temp_pin → has_pin/has_temp_pin
  booleans; updateBuilderPin + upsertBuilderRecord return {success:true} instead
  of echoing the row; admin badge reads the booleans. Verified live read-only:
  getBuilders returns no pin_hash/temp_pin; login + badges work. Response-shaping
  only; no DB/schema change; every field_ops_builders handler audited clean.

NEXT (planned, not built): GAPS 1–2 (silent data loss on DB rejection + non-push
transient misclassification). 5c/5d of lot-structure push remain ON HOLD until
GAPs 1–2 ship.

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
