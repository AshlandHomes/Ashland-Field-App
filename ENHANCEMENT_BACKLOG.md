# Enhancement Backlog — Ashland Field App

Deferred work, captured so it isn't lost. NOT built. Newest first.
(KNOWN_ISSUES.md = bugs/open follow-ups; SESSION_NOTES.md = what shipped; this = deliberate later work.)

---

## Permission foundation — deferred items (from the phase-(a) schema review)

Raised while building `sql/2026-09-24_permission_foundation.sql`. Do NOT build now;
resolve at the phase named.

- **Step (d) — resolver rules (fail-closed).** When we build the permission resolver:
  - A **module with `required_permission_id = NULL` → DENY** (no permission gates it =
    nobody gets in), never "open to all". Fail closed.
  - A **user `deny` override beats a role `grant`.** Effective = union(role grants)
    minus explicit denies; deny always wins.

- **Step (f) — builders need a `punch.respond`-type permission.** The `punch_system`
  module is gated on `punch.create`, which only `field_manager`/`super_user` hold —
  **builders lack it**, so as seeded a builder can't touch punch/checklist items they're
  meant to RESPOND to (fix/mark done). Add a builder-side permission (e.g. `punch.respond`)
  and decide the punch module's gate (any-of `punch.create`/`punch.respond`) when the
  punch system is built.

- **Step (b) — `field_ops_builders.user_id` integrity.** Phase (a) adds it as a plain
  nullable `uuid`. The backfill must add the **FK → `app_users(id)`** and a **UNIQUE**
  constraint (one builder ↔ one user). Deferred to (b) so the column can be populated first.

- **`app_users.updated_at` has no trigger.** The column defaults to `now()` on insert but
  nothing bumps it on UPDATE. Either add a `set_updated_at` trigger (BEFORE UPDATE) or drop
  the column — decide when we first write update paths for users.

- **`service_role` GRANTs on the new tables (house new-table checklist).** Nothing reads
  these tables in phase (a) (additive, nothing gated), so no GRANT is needed yet. When the
  app first reads them (gating phase / admin console), add `GRANT` to `service_role` per
  the CLAUDE_CODE_BUILD_SPEC new-table checklist, or the service key silently sees nothing.
