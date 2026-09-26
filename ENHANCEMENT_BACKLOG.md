# Enhancement Backlog — Ashland Field App

Deferred work, captured so it isn't lost. NOT built. Newest first.
(KNOWN_ISSUES.md = bugs/open follow-ups; SESSION_NOTES.md = what shipped; this = deliberate later work.)

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

- **`upsertBuilderRecord` must also create the user + builder role.** Today it inserts
  a `field_ops_builders` row only (`supabase.js:253`); a builder added after the backfill
  gets `user_id = NULL` and NO role — and would be **locked out the moment modules are
  gated**. Make new-builder creation atomically create the `field_ops_users` row + builder
  role (or run the backfill as part of it).
- **`deleteBuilder` hard-deletes and orphans the user.** Today it `DELETE`s the builder
  row (`supabase.js:248`), leaving an orphan `field_ops_users` row still holding the builder
  role. Replace with **deactivation** (`field_ops_users.status='suspended'` + hide from
  login) per the immutable-audit rule — don't hard-delete identities.
- **Shared "Admin" PIN account → named admin accounts.** `is_admin` today is a single
  shared "Admin" builder (one PIN). A shared admin identity **defeats per-person audit**.
  Replace with named admin accounts (email login → `auth.users` → `field_ops_users`, admin
  role) before gating.

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
