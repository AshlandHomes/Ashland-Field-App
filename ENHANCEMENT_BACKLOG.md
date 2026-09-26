# Enhancement Backlog — Ashland Field App

Deferred work, captured so it isn't lost. NOT built. Newest first.
(KNOWN_ISSUES.md = bugs/open follow-ups; SESSION_NOTES.md = what shipped; this = deliberate later work.)

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
