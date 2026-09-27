# Enhancement Backlog — Ashland Field App

Deferred work, captured so it isn't lost. NOT built. Newest first.
(KNOWN_ISSUES.md = bugs/open follow-ups; SESSION_NOTES.md = what shipped; this = deliberate later work.)

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
