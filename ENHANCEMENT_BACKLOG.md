# Enhancement Backlog — Ashland Field App

Deferred work, captured so it isn't lost. NOT built. Newest first.
(KNOWN_ISSUES.md = bugs/open follow-ups; SESSION_NOTES.md = what shipped; this = deliberate later work.)

---

## 🟡 2026-10-21 — manager view: calibrate "behind" on LIVE data before launch

From the Dev backfill review (29 lots): 18 of 24 started lots were >5 working days behind. If most
lots trip the "Needs attention" threshold the card is noise. BEFORE the manager view goes live:
1. Run backfillBaselines' review report on LIVE data; use it to CLOSE finished-but-still-'active'
   lots, then calibrate the behind-threshold (maybe > N wd, or a %, not a flat 5).
2. Report enhancement: a lot whose PROJECTED completion is already in the PAST (e.g. CO Lot 16:
   proj 2026-07-13, behind -364) is almost certainly finished-not-closed — show it as
   "check: finished?" (distinct from the baseline-age "check: still active?" flag). Never auto-close;
   the office decides.

---

## 🟡 2026-10-21 — manager view: "why is this lot behind?" — delay-reason rule (AGREED, not built)

The manager "Needs attention" card shows the LATEST delay reason next to "X days behind", or
"No reason given". Rules agreed:
- Ask for a reason ONLY on a late FINISH — never on a late start.
- A finish is late only if it misses the finish the schedule expected BEFORE that task started —
  i.e. the finish computed from its PREDECESSORS' dates, not from its own actual start. A first task
  with no predecessors uses the scheduled `construction_start_date`. (This is stricter/clearer than
  today's "actual_finish > projected finish" trigger — a task pushed back by a late predecessor that
  then finishes on its REVISED date is NOT late; the reason was already captured on the task in front.)
- Reuse the existing modal + `sched_task_delays` (no new table). Keep the CRITICAL-PATH-only gate
  unless there's a reason to widen it — decide when we see how often "No reason given" shows.
- Card data: latest `sched_task_delays` row per lot_id (order created_at desc) → reason_label;
  none → "No reason given". Read-only; no schema change needed for the card itself.
- Known gap: late STARTS still won't carry a reason (no finish event) — a lot can read behind with
  "No reason given". Accepted for v1.

---

## 🔴 2026-10-20 — HIGH — read actions aren't server-gated, and the API secret is handed to every client

The Netlify function (`/.netlify/functions/supabase`) authorizes requests ONLY by a shared
`X-Api-Secret`, and `/.netlify/functions/config` serves that secret to any client that loads the
site. The 2026-10-20 hotfix closed the WRITE surface (admin token on mutations; temp-PIN proof on
self-service set-PIN), but READ actions (getScheduleLots, getAllLotPhases, getBuilders, etc.) remain
ungated — anyone with the secret can read all field-ops data, and the manager view's read endpoints
on live would inherit that. The real fix is PER-USER server auth (the Dev token model: a signed
login token required + permission checked on every read/write), which lands after the DB is
separated from LandIQ. Until then, treat the shared secret as "any site visitor" for reads.

ALSO (manager view S-b, 2026-10-23): task-WRITE actions (updateScheduleLotTask / bulkUpdateLotTasks /
editLotTask / addWalkNote / gate confirm / applyLotStructure*) carry NO per-user identity today —
only the shared secret — so the server cannot cheaply/reliably tell a manager from a builder on a
write. A partial check ("refuse if a manager login token is present") is bypassable by simply not
sending the token, so it adds no real protection and was NOT added. v1 relies on the CLIENT guard
(_managerBlocked early-returns in every write handler) plus managers having NO edit UI (read-only
render, S-e). TRUE server enforcement = this per-user-auth item: require the signed login token on
every write and refuse manager roles for task mutations.

## 🔴 2026-10-11 — HIGH (before any manager/permission work goes live) — offline PIN cache on the phone
Already logged in full below (afo_creds_v1 SHA-256 of a 4-digit PIN; replace with caching the signed
token). Re-affirmed 2026-10-20: this must be closed before managers rely on device auth on live.

## 🟡 2026-10-20 — BEFORE LIVE — delete the Dev "Test Manager" account
Dev seeded a `dev_field_ops_users` row display_name='Test Manager' (field_manager role, PIN set) for
S2 testing. It exists ONLY on Dev and must NOT survive into any live/user-facing state — delete it
(and its user_roles row) before the manager view goes live. (Live has no users table yet, so nothing
to delete on live today; this is a Dev-cleanup gate for the promote.)

---

## 🔴 2026-10-11 — HIGH PRIORITY (must land BEFORE any manager/permission work goes LIVE) — offline login caches a PIN-derived secret on the device

The field app's OFFLINE login caches a PIN-derived **SHA-256** in `localStorage` under
`afo_creds_v1` (keyed per builder; **survives logout** by design — the session pointer
`afo_session_v1` is cleared on logout, this credential store is not). The hash is
`SHA-256('afo:' + builderName + ':' + pin)` (`_pinHash`, ashland-stage-update-dev.html:480),
compared against the typed PIN in the offline branch of `tryPin` (:571) and on mid-login network
failure (:556).

**Why it matters:** for a **4-digit PIN** with a known builder name and a known static prefix,
all 10,000 candidates can be hashed and matched in milliseconds by anyone who can read
`localStorage` on the device — so it is effectively the PIN for a local attacker ("hashed, not
plaintext" is technically true but gives ~no protection here). It also persists indefinitely.
This predates S1b and S1b did not change it (the server never sends this — it's the client's own
scheme), but it must be closed before managers/permissions rely on device auth.

**Also record:** in a **non-secure context** (no `crypto.subtle`), `_pinHash` falls back to a weak
32-bit **djb2** hash (`:485`) — even weaker than the SHA-256 path.

**Fix (NOT built):** stop caching a PIN-derived secret. On online login the server now returns a
**signed, expiring token** (S1b, HMAC-SHA256, 7-day exp). Cache **that token** (plus a "last
builder" flag) for offline re-entry instead of a PIN hash — the device re-enters offline by
presenting a token it cannot forge and that reveals no PIN, bounded by expiry. Remove `afo_creds_v1`
/ the `_pinHash` credential path. (Weaker interim if a PIN hash must stay: a slow salted KDF —
PBKDF2/scrypt via WebCrypto with a per-device random salt — which only slows, never closes, a
10k-PIN enumeration.)

---

## 🟢 2026-10-11 — LOW PRIORITY — forced "Create your PIN" accepts weak / unchanged PINs

The forced first-login PIN change (field app `setPinKey` → `setBuilderPin`) accepts a new PIN
IDENTICAL to the temp PIN — it should reject "same as your temporary PIN, pick a different one."
(Surfaced in S1b step 2: the check only looked unchanged because the temp and new PIN were both
`0000`.) Also reject obvious PINs: `0000`, `1234`, and single-digit repeats (`1111`…`9999`).
Enforce on the client for UX and ALSO server-side in `dev_field_ops_set_pin` (or the handler) so
it can't be bypassed. Not acute; no security regression beyond the existing 4-digit space.

---

## 🔭 2026-10-06 — single-source follow-ups (noted during the stage display-only fix)

Recorded while fixing the stage dual-calculation bug (stage is now server-only; the phone
displays `reported_stage`/`true_stage`). Two related items left for later — do NOT build yet:

- **Completion / projected date is still computed in two places.** The field app projects the
  finish date CLIENT-side (`renderSchedule` → `recompute()` → `offToDate(projEnd)`; the frozen
  `completion_health_delta`/`completion_wd_elapsed` are client-computed at stamp time), while the
  admin/server has its own projection (`getAllLotPhases` → `computeProjected`, the "OLD-C" copy
  the parity harness flagged for negative-lag / floor-at-1 differences). Same class as the stage
  bug — unify onto one calculator (server-authoritative, phone displays) so field-app and admin
  dates can't diverge. Not acute (no single stored "completion" column a list displays, so no
  list↔screen flip), hence deferred.

- **Hold gates are read from two sources.** The server stage path reads gates from the TEMPLATE
  (`sched_template_gates` + per-lot `sched_lot_gate_state` confirmations); the old client path read
  them from the LOT's gate rows (`getScheduleLotTasks` data.gates). Moot now that only the server
  computes stage, but recorded: if a future feature needs gate state client-side, reconcile the
  two sources (template `hold_task_bt_nums` vs lot gate rows) rather than trusting either alone.

---

## ✅ SHIPPED 2026-10-04 — queue failure-classification fixes (GAP 1+2)

**RESOLVED — merged to live `ec6ccda` (hotfix/queue-integrity).** GAP 2: every write handler
now surfaces r.error (dbFail) instead of 200+null; single-record PATCH/DELETE treat a 0-row
match as a permanent "not found". GAP 1: ONE transient/permanent classification for all queued
actions (permanent = 400/409/422 + date-guard + not-found + unknown-action, tagged by the server
or by sbCallRaw from the HTTP status when untagged; everything else transient → retries). Per-lot
ordering barrier so a retry can't overwrite a newer same-lot edit; a transient action stuck
≥3 attempts shows "Still saving — can't reach the server. It'll keep trying." See SESSION_NOTES
2026-10-04. **Deferred Dev tests (still to run later, NOT blocking):** (a) online transient →
retry → "Still saving" surfacing + self-clear on reconnect; (b) per-lot ordering barrier (a stuck
transient holds a newer same-lot edit until it lands, in order). Lot-structure push 5b/5c/5d
resumes next now that GAPs are live.

The original audit, kept for the record:

- **GAP 2 (SILENT DATA LOSS — LIVE TODAY, do first).** Six write handlers return
  `{statusCode:200, body: JSON.stringify(r.data)}` **without checking `r.error`**, so a real
  DB/RLS/constraint failure comes back as `r.data = null` → the drain marks the action
  **synced** → the write is silently lost while the builder sees success. Evidence
  (`netlify/functions/supabase.js`): `updateScheduleLotTask` :1344–1348, `editLotTask` :1378,
  `addTaskNote` :1504–1508, `updateTaskNote` :1528, `updateScheduleLotGate` :1483,
  `addTaskDelay` :1133–1142. (`supabaseRequest` already surfaces the error as `{status,error}`
  — :51–54 — the handlers just ignore it.) **Fix:** each handler must detect `r.error`/`r.status>=400`
  and return a real error response (with a `permanent` flag where the failure is structural),
  so the drain retains + surfaces it instead of reporting success.

- **GAP 1 (no transient/permanent split for non-push actions).** The drain treats **any**
  server-returned `.error` on a non-push action as permanent → `markFailed` → never retried
  (`ashland-stage-update-dev.html` drain `:1194–1205`, the `else` at `:1203`; only `push_lot`
  honors a `permanent` flag, `:1201`). A transient 500 / DB blip
  (`respondNoteResolution` 500 `supabase.js:1584`; outer `catch` 500 `:1830`) is thus dropped
  permanently — the opposite of "never lose a queued action." **Fix:** give non-push actions
  the same `permanent`-flag classification `executePushLot` already uses — only structural
  (validation) failures become `failed`; transient ones stay `pending` and retry.

Today GAP 1 rarely fires (non-push validation errors are pre-caught client-side, so the common
case never reaches the queue) but GAP 2 is active silent loss on every DB-level write rejection.
The failed-items sheet is honest about push failures but blind to both of these until fixed.

---

## 🔐 SECURITY (2026-09-27 — from the live-exposure assessment)

Recorded during the live anon-exposure work.
- ✅ **RESOLVED 2026-09-27 — LIVE anon lockdown.** Dropped all permissive policies +
  revoked anon/authenticated + enabled RLS on all 23 live field-app tables
  (`sql/2026-09-27_live_anon_lockdown.sql`). Verified 4/4 PASS + live smoke test; rollback
  (STEP 0 output) held by Collin. See SESSION_NOTES 2026-09-27.
- ✅ **RESOLVED 2026-10-04 — PIN-leak fix SHIPPED to live** (merge `9ed6f10`,
  hotfix/pin-leak). getBuilders strips pin_hash/temp_pin → has_pin/has_temp_pin booleans;
  updateBuilderPin + upsertBuilderRecord return {success:true} (no row echo); admin badge
  reads booleans. Every field_ops_builders handler audited clean (verifyPin compares
  server-side only). Verified live read-only (no pin fields in getBuilders). See
  SESSION_NOTES 2026-10-04. (The failed-items sheet also shipped same day, merge `56284d9`.)
- **Minimize client-facing columns (principle).** `getBuilders` no longer leaks
  `pin_hash`/`temp_pin`, but still returns fields the login screen doesn't use
  (`user_id`, `failed_attempts`, `biometric_credential_id`, `created_at`, `updated_at`).
  Client-facing handlers should return only what the UI needs — tighten `getBuilders`
  (and audit the other read handlers) to an explicit minimal column set.

The deferred ones below remain:

- **PINs are stored PLAINTEXT.** `field_ops_builders.pin_hash` holds the raw 4-digit PIN
  (`verifyPin` compares `pin_hash === pin`, `supabase.js`; `setBuilderPin` writes
  `pin_hash: pin`). The column name is a misnomer. **Hash PINs server-side** (in the Netlify
  function) — hash on write, compare hash on verify — so a DB/response leak never exposes a
  usable PIN. Migrate existing rows (rehash on next successful login, or force reset).
- **No server-side authorization per action.** The Netlify function's only gate is
  `API_SHARED_SECRET`, and that secret is handed to the browser via
  `/.netlify/functions/config` — so the function is effectively public. ANY caller can invoke
  ANY action: `upsertBuilderRecord` (create an admin), `updateBuilderPin`/`setBuilderPin`
  (take over any account), `unlockBuilder`, `deleteBuilder`, `verifyAdminPin` (brute-force),
  and every lot/task/template/company/subdivision write. **This is the permission
  foundation's job (step d) + DB separation** — per-action authorization tied to the
  authenticated user's effective permissions. Do NOT bolt on a partial check; build it with (d).
- **Netlify env: mark secrets as secret.** `SUPABASE_SERVICE_ROLE_KEY` and
  `API_SHARED_SECRET` are NOT marked "secret" in Netlify (other keys are). Mark both secret
  (all scopes / deploy contexts) so they aren't exposed in build logs or the UI.

---

## 🧭 DATABASE SEPARATION — committed direction (2026-09-26)

LandIQ and the field app / admin console / manager module **will move to SEPARATE Supabase
projects.** Sequenced AFTER the 3 BLOCKS-STEP-(d) items below and BEFORE any permission gating
goes live:

1. **Fix the 3 BLOCKS-STEP-(d) items on Dev** (create/delete builder atomicity + deactivation;
   named admins). These are pre-requisites regardless of separation.
2. **Separate — pure infra move, ZERO feature changes.** New project holds `field_ops_*` /
   `sched_*` (+ our `auth.users`). Verify live before anything else changes.
   - **VERIFICATION (not a blocker):** Collin confirms ~99% LandIQ reads no `field_ops_*` /
     `sched_*`. Before cutover, **grep the LandIQ repo for `field_ops_` / `sched_` references**,
     OR smoke-test LandIQ immediately after cutover with **rollback ready**.
3. **Promote the permission foundation into the new project** (it never has to reconcile with
   LandIQ's auth — once separated, THE SEAM disappears and `auth.users` is ours alone).

**LOGIN PLAN (records the target so we don't drift):**
- *Until separation:* named admin accounts use **PIN only** — nothing touches shared `auth.users`.
- *After separation:* **admin console → username/password**; **builders + managers (manager view
  is in the field app) → PIN**; **Face ID later.** `field_ops_builders.biometric_credential_id`
  already exists (per Collin) but **no application code references it today** (grep-clean) — treat
  as a dormant/reserved column; document its consumer when Face ID is actually built.
- **Manager PIN storage must move up.** PINs live on `field_ops_builders` today (the builder
  login/assignment list). Managers are not builders → move PIN storage to the **user level**
  (`field_ops_users` or a credentials table) before managers get PINs. Short-term, named admin
  PINs may reuse the builders table + `is_admin`.

---

## Predecessor warning + template fidelity (from the lag-aware fix)

- **Lag-window-aware warning.** The lag-aware fix skips the finish-time predecessor
  warning ENTIRELY for a negative-lag (lead-time) task. But a lead time is a *window*,
  not "no dependency": "drop material 6 days before framing" still assumes framing is
  coming. If the predecessor hasn't even STARTED, finishing the lead-time task may still
  be out of sequence. Refine: for negative-lag, warn only when the predecessor is
  *not started* (vs unfinished); keep the current skip when it's started-but-unfinished.
  (`ashland-stage-update-dev.html`, `finishTask` incompletePreds.)

- **Template task count: 129 vs 148 in Buildtopia.** Our active template has 129 tasks;
  the Buildtopia source has 148. Reconcile the 19-task gap — determine which are
  intentionally dropped vs missing, and whether any missing tasks are schedule-driving
  (critical path / gates). Investigation first, then a template-builder update if needed.

---

## 🔒 BLOCKS STEP (d) — must resolve before gating modules by permission

Raised during the step-(b) builder backfill. If a builder ends up with no user /
no role, gating locks them out; a shared admin identity defeats the audit. Resolve
ALL of these before any permission gating goes live.

- **`upsertBuilderRecord` must also create the user + builder role.** ✅ BUILT on Dev
  (blocker 1, commit `4cb8c2f`; pending live). `upsertBuilderRecord` now calls the atomic
  `dev_field_ops_create_builder` RPC (add-only: creates the builder + `field_ops_users` row +
  role in one transaction; refuses existing names). Still to do at promote: apply the LIVE
  `field_ops_create_builder` function.
- **`deleteBuilder` hard-deletes and orphans the user.** Today it `DELETE`s the builder
  row (`supabase.js:248`), leaving an orphan `field_ops_users` row still holding the builder
  role. Replace with **deactivation** (`field_ops_users.status='suspended'` + hide from
  login) per the immutable-audit rule — don't hard-delete identities.
- **Shared "Admin" PIN account → named admin accounts.** `is_admin` today is a single
  shared "Admin" builder (one PIN). A shared admin identity **defeats per-person audit**.
  Replace with named admin accounts (email login → `auth.users` → `field_ops_users`, admin
  role) before gating.

### Role model must be flexible + editable (Collin's requirement)

The data model already supports this (multi-role: `dev_field_ops_user_roles` PK is
`(user_id, role_id)`; effective permissions = union of all roles' grants, minus any
per-user `deny` override; `super_user` holds all 9 permissions). What's missing is the
surface + credential + gating to actually use it. Target example: ONE super_user launches
the field app (as a builder), the manager view (as a manager), and the admin console — same
person, multiple roles. Resolve before gating:

- **User & Role management screen** in the admin console, gated by `users.manage`: view any
  user, add/remove any roles (MULTI-role, not builder-XOR-admin — that rule lives only in the
  one-time backfill and the create function's INITIAL role, never in the data model),
  deactivate/reactivate. Changes take effect on the user's **next login**.
- **PIN credential moves off `field_ops_builders` to the user level** (`field_ops_users` or a
  credentials table) so ANY user type — builder, manager, super_user, admin — can hold a PIN
  and launch the modules their roles allow. Today PINs live on the builder row, so a non-builder
  user cannot log into the field app at all.
- **Retire `is_admin`.** Admin access must come ONLY from roles (the `admin`/`super_user` role
  via `user_roles`), so there is one source of admin truth. Migrate `is_admin=true` builders to
  the role, then drop the column. (Removes the second admin mechanism; pairs with retiring the
  shared `ADMIN_PIN` env gate.)

---

## Permission foundation — deferred items

Foundation rebuilt under `field_ops_` after the 2026-09-26 LandIQ collision (see
`sql/2026-09-26_permission_foundation_fieldops.sql`). Do NOT build now; resolve at
the phase named. (The earlier `app_users`-specific items are dropped — we no longer
touch LandIQ's `app_users`; our identity is `field_ops_users`.)

- **Step (d) — resolver rules (fail-closed).** When we build the permission resolver:
  - A **module with `required_permission_id = NULL` → DENY** (no permission gates it =
    nobody gets in), never "open to all". Fail closed.
  - A **user `deny` override beats a role `grant`.** Effective = union(role grants)
    minus explicit denies; deny always wins.

- **Step (d) — shared-email = shared login.** `auth.users` is one table for the whole
  project (shared with LandIQ), and email is unique project-wide. So if a LandIQ user
  and a field-app manager use the **same email, they share ONE login** (one `auth.users`
  row → both `app_users` and `field_ops_users` map to it). Decide the intended policy
  (one identity across the ERP, vs. separate) before wiring manager email login.

- **Step (f) — builders need a `punch.respond`-type permission.** The `punch_system`
  module is gated on `punch.create`, which only `field_manager`/`super_user` hold —
  **builders lack it**, so as seeded a builder can't touch punch/checklist items they're
  meant to RESPOND to (fix/mark done). Add a builder-side permission (e.g. `punch.respond`)
  and decide the punch module's gate (any-of `punch.create`/`punch.respond`) when built.

- **Step (b) — `field_ops_builders.user_id` integrity.** The column exists as a plain
  nullable `uuid`. The backfill must add the **FK → `field_ops_users(id)`** (OUR table,
  never LandIQ's) and a **UNIQUE** constraint (one builder ↔ one user). Deferred to (b)
  so the column can be populated first.

- **`field_ops_builders.is_admin` → migrate to a role, then retire the column.** Builders
  already carry an `is_admin` flag — that's a **second admin mechanism** alongside the new
  role model. When we cut over, map `is_admin=true` builders to the `admin` (or
  `super_user`) role via `user_roles`, then retire the column so there's ONE source of
  admin truth.

- **`field_ops_users.updated_at` has no trigger.** Defaults to `now()` on insert but
  nothing bumps it on UPDATE. Add a `set_updated_at` BEFORE-UPDATE trigger or drop the
  column — decide when we first write user update paths.

- **`service_role` GRANTs on the new tables (house new-table checklist).** Nothing reads
  these tables in phase (a) (additive, nothing gated), so no GRANT is needed yet. When the
  app first reads them (gating phase / admin console), add `GRANT` to `service_role` per
  the CLAUDE_CODE_BUILD_SPEC new-table checklist, or the service key silently sees nothing.

## admin-dev hold re-derivation — collapse to the server's conclusion (admin-only, display-only)

- **admin-dev re-derives the HOLD conclusion client-side** in `openStageModal`
  (`admin-dev.html:1263-1264` manualGates/gatesOpen; `:1326-1333` picks its own blocking
  gate + "Held at X — actually Y"). This is a SECOND computation of a fact the server already
  owns via `computeStage` (`hold_gate_name` / `hold_message` / the held cap) and CAN disagree —
  the modal banner excludes task-driven gates the server counts. **Collapse:** the modal should
  take the held/blocked CONCLUSION from the server's `hold_gate_name` / `hold_message`, and use
  the raw gate rows only for the per-gate chip display (pure display of source data). Stage
  itself is NOT re-derived (read from the server) — only the hold conclusion is. Non-blocking;
  do as a dedicated admin-dev cleanup step.

- **Move hold AGING to the server.** `holdDays` / `holdSince` (`admin-dev.html:1269-1285`, via
  `ScheduleEngine.wdBetween` over raw actual_finish) has NO server equivalent today — it's
  admin-only. Lift it into a server helper so builder / admin / manager could all show ONE
  aging number from one source. Lower priority than the conclusion collapse above.

## MANAGER VIEW — GO-LIVE GATES (plan; manager view is COMPLETE + verified on Dev)

Recommended order. Size = small / medium / large. "Dep" = hard dependency.

HARD BLOCKERS (in order):
1. **Live S1a/S1b/S2 + baseline-table SQL** — medium. Dep: none. Promote the already-Dev-verified
   SQL to LIVE (unprefixed): users PIN columns + migrate live builder PINs → users (hashed);
   verify_login / set_pin / claim_temp_pin RPCs; manager_view permission + manager role; and the
   field_ops_lot_baseline table. Everything per-user depends on this existing live.
2. **Per-user server auth / read-gating** — large. Dep: 1. Today every client is handed the shared
   API_SHARED_SECRET via /config, so writes aren't identity-bound and manager read-only is only
   enforced CLIENT-side. Bind writes to the logged-in user's signed token → server identity →
   permission checks, so a manager is refused mutations by the SERVER, not just the missing UI.
   This is the real security blocker for launch.
3. **Offline PIN cache → signed token** — medium. Dep: 2. Offline today trusts a local PIN hash;
   under per-user auth the offline path must carry/refresh a signed login token so offline writes
   sync WITH identity. (Builders offline must keep working exactly as today.)
4. **Manager-view code promote (Dev → main)** — medium. Dep: 1, 2 (3 for offline correctness).
   Ship S-a…S-g. sw cache bump; generate-live.js strips DEV banner.
5. **Live baseline backfill + review report + threshold calibration** — medium. Dep: 1 (table), 4
   (code live). Run backfillBaselines on live, review the report (first_actual_start, stale_check),
   then calibrate BEHIND_WD_THRESHOLD / STALE_DAYS against real live data BEFORE managers see
   numbers.
6. **Delete Dev Test Manager + provision real live managers** — small. Dep: 1. Remove the Dev test
   manager; grant the manager role to the actual people on live.
7. **Live stale-PIN-column drop** — small. Dep: 1 + confirm live reads come from field_ops_users.
   Same script as sql/2026-10-23_drop_stale_builder_pin_cols.sql vs field_ops_builders (unprefixed).
8. **Live delay-reason list cleanup** — small. Dep: read-only check of live sched_delay_reasons
   first (add "Permit / lot not ready"; archive any junk like "Test"/"Test 28" if present live).

PARALLEL / NON-BLOCKING:
- **admin-dev hold collapse + move hold aging to server** — medium. Anytime; correctness/single-source.
- **DB separation from LandIQ** — large, strategic. The standing shared-DB risk. Does NOT strictly
  block manager view v1 read-only launch IF (2) + RLS are airtight, but it's the biggest debt and
  the proper home for field-ops-only tables. If it is done FIRST, it reorders everything: items 1/7
  run against the separated DB and the dev_/'' prefix split goes away. Decision needed:
  launch-then-separate, or separate-then-launch.
