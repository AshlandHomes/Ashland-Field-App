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

## 2026-10-20 — DECISION: frozen baseline counts from the SCHEDULED construction start (manager view S3, Dev)

The frozen baseline completion (dev_field_ops_lot_baseline, S3) is the engine planEndDate computed
from the lot's **scheduled `construction_start_date`**, NOT from the actual first start. A lot that
starts LATE therefore reads as **behind** from day one — intended. The baseline is captured the
moment construction actually begins (first `actual_start`) but its VALUE is the plan measured from
the scheduled start. Verified on Dev: HP Lot 13 (scheduled start Aug 10) froze baseline 2026-12-17;
after a late/slow start the phone shows projected Feb 26 2027 = "51d behind". Design kept as-is.

---

## 2026-10-20 — PIN/login security hardening — DEV chain built + LIVE hotfix SHIPPED (merge `389a75a`)

**The hole:** the Netlify function trusted only the shared `X-Api-Secret`, which `/.netlify/functions/
config` hands to any client — so anyone could call setBuilderPin/updateBuilderPin/unlockBuilder/
upsertBuilderRecord/deleteBuilder by name with no proof. Post-S2 that let someone set any person's
PIN and become a manager.

**DEV chain (verified, not promoted except the hotfix below):**
- S1a `2026-10-10_users_pin_login.sql` — PIN columns (pin_hash/temp_pin_hash/failed_attempts/
  is_locked) on `dev_field_ops_users`, builder PINs migrated hashed (bcrypt via pgcrypto). 7/7 PASS.
- S1b `2026-10-10_verify_login_fn.sql` — SECURITY DEFINER RPCs verify_login/set_pin/unlock_user;
  login compares in-DB, returns roles + a 7-day HMAC field token (FIELD_OPS_TOKEN_SECRET), never a
  hash. One login for everyone. Verified.
- S2 `2026-10-11_manager_view_permission.sql` — manager_view.use gate (already seeded by the
  foundation); server `_requireManager` resolves effective permission from the DB (token proves WHO,
  DB decides WHAT); `getManagerPing` stub. Seeded a Test Manager. Verified (builder→403, none→401,
  tampered→401).
- Security fix `2026-10-11_claim_temp_pin_fn.sql` — self-service set-PIN proves the temp PIN
  atomically; admin mutations require a signed 12h admin token (`_requireAdmin`); admin console
  re-prompts on expiry. Verified end-to-end on Dev.

**LIVE HOTFIX — SHIPPED (merge `389a75a`, 4 files, zero DB change):** adapted for live's cleartext
builder columns — admin token (12h, FIELD_OPS_TOKEN_SECRET on the LIVE site) gates
updateBuilderPin/unlockBuilder/upsertBuilderRecord/deleteBuilder; setBuilderPin requires + verifies
the temp PIN (wrong tries count toward lockout, new==temp refused); admin.html/field-app
regenerated from -dev (byte-identical to generate-live); sw.js v5→v6. NONE of the Dev users/
permission/hashing/RPC work rode along. Live checks S1–S5 all PASS (create w/ token, forged
unlock→403, temp→permanent, no-temp refused, delete w/ token). Pre-merge live state:
builders_with_temp_pin=0, locked=0.

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

---

## 2026-10-23 — Manager view v1 (S-d → S-f) + single-source enforcement

### Standing rule locked (Collin): no duplicate data sets
Every manager field reads the single central source. Any new table/column needs approval
first with a reason it can't come from existing data. Full data-source audit done this
session (every getManagerNeedsAttention field → table.column or shared server fn; confirmed
nothing cached into a manager store).

### S-d — manager home UI (commit beacb64)
Count header "Needs attention N of M"; severity-sorted cards (behind→held→quiet, excl.
check-finished-only); "Check: finished?" group; all-lots-by-subdivision + builder filter.

### S-e — read-only lot screen (commit ca40dee)
screen-mgr-lot: zero edit controls, "Read-only" chip. Tasks from getScheduleLotTasks (same
read as builder openLot); per-task projected dates via shared ScheduleEngine.computeLotSchedule;
header facts from _mgrData. construction_start_date now carried on the manager payload (single
source sched_lots). Own _mgrLot/_mgrLotId vars — never touches builder TASKS/act/curLot.

### Stale builder PIN columns — DROPPED on Dev (sql/2026-10-23_drop_stale_builder_pin_cols.sql)
Since S1b flipped all PIN reads/writes to dev_field_ops_users, the columns pin_hash / temp_pin /
failed_attempts / is_locked on dev_field_ops_builders were read/written by nothing (only scrubbed
from API output). Cleared + dropped. Corrected A2: orphans 0; Block B: success; verification
PASS; builder login (Dennis Duncan) verified working after the drop. Coverage gate fixed to flag
a true orphan only (old cleartext here AND no credential at all on the linked user) — a builder
who moved temp→permanent on the user (e.g. Stephen Connor) is fully migrated, not an orphan.
LIVE equivalent waits for DB separation, after live S1a/S1b, same script vs field_ops_builders.

### S-f — phone behind-switch (THIS commit)
getScheduleLots + getManagerNeedsAttention both call one new shared helper _attachBaselineBehind
(baseline_date / projEndDate / started / behind_wd) — ONE calculation, so the builder's "behind"
IS the manager card's "behind". The phone's Health card reads curLot.behind_wd and no longer
computes planEnd−projEnd. Not-started → "Not started" (no number); offline/unsynced → "⏳ pending
sync" (never a stale/invented number); completed lot keeps its frozen stamp. behind_wd refreshes
with the stage badge after a sync. Ships with the manager view, never split. sw cache v7→v8.

### S-f — phone behind-switch (commit a42a560) + offline-login regression fix (commit 4eb0a35)
Both reads feed one shared helper _attachBaselineBehind; phone Health card reads server
behind_wd (not-started → "Not started"; offline/unsynced → "⏳ pending sync"). Fixed a
regression where S-a's getLoginList left the offline login list empty: loadBuilders now
falls back to afo_creds_v1 (on-device builders) when the server list is unavailable.
Verified: CT Lot 31 −34, CT Lot 33 +1, HP Lot 14 not-started matched across server/manager/
builder; offline Dennis login + "⏳ pending sync" both PASS.

### S-g — delay-reason rule (THIS commit)
Reason is prompted on a late FINISH only, never a late start. "Late" = actual finish AFTER
the finish the schedule expected BEFORE the task started — _expectedFinishYmd(n): the SAME
shared engine the server uses (ScheduleEngine.computeFieldSchedule → the same computeSchedule
core as computeLotSchedule) run projected over a COPY of `act` with THIS task removed, so its
early-start is driven by predecessors' actual finishes (or the construction_start floor for a
predecessor-less task). A task that merely started late is never prompted; a task pushed back
by a late predecessor that finishes on its revised date is NOT late. Critical-path gate kept
(t._crit). Same modal / reason list / sched_task_delays; days_late stored against the expected
finish; modal label now "Expected finish". Bulk-push delay inheritance unchanged (copies the
stored rows verbatim). sw cache v9→v10.

## 2026-10-24 — MANAGER VIEW v1 COMPLETE on Dev (S-a → S-g)
The whole chain verified on Dev: S-a one login list; S-b role routing + write guards; S-c
gated getManagerNeedsAttention; S-d manager home; S-e read-only lot screen; S-f phone
behind-switch (shared behind_wd) + offline-login regression fix; S-g delay-reason on late
FINISH vs predecessor-expected finish. Single-source rule held throughout (no manager store;
one shared engine; one baseline/behind helper). Delay-modal dates now use the app short
format. **Go-live gate list recorded in ENHANCEMENT_BACKLOG ("MANAGER VIEW — GO-LIVE GATES").**
Follow-ups pending Collin: Dev delay-reason cleanup (add "Permit / lot not ready", archive
"Test"/"Test 28"); live reason-list junk is a read-only check awaiting his run.
