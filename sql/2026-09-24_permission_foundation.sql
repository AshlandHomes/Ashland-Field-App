-- ============================================================================
-- Permission / Module FOUNDATION — schema migration (phase (a) of the platform
-- permission build). ADDITIVE ONLY. Nothing reads or enforces these tables yet.
--
-- GOAL: one unified user + role + permission + module model for the whole
-- platform (field app, admin console, manager view), so identity and "who can
-- do what" live in ONE place — not fragmented per surface. This phase builds the
-- structure alongside the EXISTING PIN auth, which is left completely untouched.
-- No builder is affected. No login path changes. No RLS enforced here.
--
-- SAFETY / ISOLATION:
--  * dev/live via TABLE_PREFIX: this file's DEV SECTION creates dev_* tables on
--    Dev. LIVE runs at promote — AND the live identity anchor must first be
--    reconciled with LandIQ's existing auth (see THE SEAM below). Run only the
--    DEV SECTION now.
--  * Every statement is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) —
--    safe to re-run.
--  * The one change to an existing table is ADD COLUMN IF NOT EXISTS user_id on
--    dev_field_ops_builders — a nullable column, backfilled in phase (b). It
--    changes nothing about PIN login (online or offline).
--  * RLS is ENABLED with NO policies on ALL 8 new tables = deny-all to
--    anon/authenticated; the app's admin (service) key bypasses RLS, so nothing
--    breaks and no identity/authorization data is ever exposed to anon. Real
--    policies land in the gating phase, not here.
--  * Each section ends with NOTIFY pgrst, 'reload schema' so PostgREST registers
--    the new tables/columns immediately.
--
-- THE SEAM (finalize BEFORE any LIVE apply): app_users.auth_user_id links a
-- unified user to Supabase auth.users. LandIQ already lives on auth.users in this
-- same project and may already have a profiles/roles shape. On Dev we build
-- standalone (auth_user_id nullable, test users need no auth.users row). Before
-- LIVE we read LandIQ's auth schema and decide: reuse its profiles table vs. keep
-- app_users; map its roles into `roles`; compose RLS. That decision is the LIVE
-- section — deliberately NOT written yet.
-- ============================================================================


-- ########################  DEV SECTION (run now)  ###########################

-- 1) UNIFIED USER ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dev_app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid,                                   -- SEAM: -> auth.users(id), filled at live integration (nullable on Dev)
  display_name  text NOT NULL,
  email         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dev_app_users ENABLE ROW LEVEL SECURITY;   -- deny-all (no policies); admin key bypasses

-- 2) ROLES -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dev_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,                     -- builder | admin | field_manager | super_user
  name        text NOT NULL,
  description text
);
ALTER TABLE dev_roles ENABLE ROW LEVEL SECURITY;       -- deny-all; authorization data, never anon-writable

-- 3) PERMISSIONS -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dev_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,                     -- e.g. field_app.use, admin_console.use, users.manage
  description text
);
ALTER TABLE dev_permissions ENABLE ROW LEVEL SECURITY;  -- deny-all; authorization data, never anon-writable

-- 4) ROLE -> PERMISSIONS (the bundle) ---------------------------------------
CREATE TABLE IF NOT EXISTS dev_role_permissions (
  role_id       uuid NOT NULL REFERENCES dev_roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES dev_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
ALTER TABLE dev_role_permissions ENABLE ROW LEVEL SECURITY;  -- deny-all; the bundle IS the authorization, never anon-writable

-- 5) USER -> ROLES (multi-role = union of permissions) ----------------------
CREATE TABLE IF NOT EXISTS dev_user_roles (
  user_id uuid NOT NULL REFERENCES dev_app_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES dev_roles(id)     ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
ALTER TABLE dev_user_roles ENABLE ROW LEVEL SECURITY;

-- 6) USER -> PERMISSION OVERRIDES (per-user grant/deny escape hatch) ---------
CREATE TABLE IF NOT EXISTS dev_user_permission_overrides (
  user_id       uuid NOT NULL REFERENCES dev_app_users(id)   ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES dev_permissions(id) ON DELETE CASCADE,
  effect        text NOT NULL CHECK (effect IN ('grant','deny')),
  PRIMARY KEY (user_id, permission_id)
);
ALTER TABLE dev_user_permission_overrides ENABLE ROW LEVEL SECURITY;

-- 7) MODULES (each surface, permission-gated, individually on/off) -----------
CREATE TABLE IF NOT EXISTS dev_modules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                    text UNIQUE NOT NULL,          -- field_app | admin_console | manager_view | punch_system
  name                   text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  required_permission_id uuid REFERENCES dev_permissions(id)
);
ALTER TABLE dev_modules ENABLE ROW LEVEL SECURITY;     -- deny-all; module on/off is authorization, never anon-writable

-- 8) MANAGER (and later builder) SUBDIVISION ASSIGNMENT ----------------------
CREATE TABLE IF NOT EXISTS dev_user_subdivisions (
  user_id          uuid NOT NULL REFERENCES dev_app_users(id) ON DELETE CASCADE,
  subdivision_code text NOT NULL,                       -- community code (e.g. 'CT'), matches sched_lots.community
  PRIMARY KEY (user_id, subdivision_code)
);
ALTER TABLE dev_user_subdivisions ENABLE ROW LEVEL SECURITY;

-- 9) LINK the existing builder identity to a unified user (additive, nullable)
--    Backfilled in phase (b). PIN login (online + offline) is unaffected.
ALTER TABLE dev_field_ops_builders ADD COLUMN IF NOT EXISTS user_id uuid;   -- -> dev_app_users(id), FK added with the backfill


-- ####################  SEED the roles / permissions / modules  ##############
-- Data-driven so future roles/modules are config, not code. ON CONFLICT keeps re-runs safe.

INSERT INTO dev_roles (key, name, description) VALUES
  ('builder',       'Builder',       'Field app: own lots'),
  ('admin',         'Admin',         'Admin console + user/role/module management'),
  ('field_manager', 'Field Manager', 'Manager view + punch/checklist'),
  ('super_user',    'Super User',    'All modules and management')
ON CONFLICT (key) DO NOTHING;

INSERT INTO dev_permissions (key, description) VALUES
  ('field_app.use',     'Use the field app'),
  ('admin_console.use', 'Use the admin console'),
  ('manager_view.use',  'Use the manager view'),
  ('users.manage',      'Create users, assign roles'),
  ('modules.manage',    'Turn modules on/off'),
  ('roles.manage',      'Edit roles and their permissions'),
  ('schedule.edit',     'Edit lot task/gate status'),
  ('punch.create',      'Create punch/checklist items'),
  ('punch.verify',      'Verify/close punch items')
ON CONFLICT (key) DO NOTHING;

-- role -> permission bundles
INSERT INTO dev_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM dev_roles r, dev_permissions p WHERE
     (r.key='builder'       AND p.key IN ('field_app.use','schedule.edit'))
  OR (r.key='admin'         AND p.key IN ('admin_console.use','users.manage','modules.manage','roles.manage','schedule.edit'))
  OR (r.key='field_manager' AND p.key IN ('manager_view.use','punch.create','punch.verify'))
  OR (r.key='super_user')                                          -- super_user = every permission
ON CONFLICT DO NOTHING;

-- modules, each gated by its permission
INSERT INTO dev_modules (key, name, enabled, required_permission_id)
SELECT m.key, m.name, true, p.id FROM (VALUES
    ('field_app',     'Field App',      'field_app.use'),
    ('admin_console', 'Admin Console',  'admin_console.use'),
    ('manager_view',  'Manager View',   'manager_view.use'),
    ('punch_system',  'Punch / Checklist','punch.create')
  ) AS m(key, name, perm)
  JOIN dev_permissions p ON p.key = m.perm
ON CONFLICT (key) DO NOTHING;

-- Make PostgREST see the new tables/columns immediately (else the API 404s them
-- until a redeploy). Final line of the section per the house new-table checklist.
NOTIFY pgrst, 'reload schema';

-- ########################  END DEV SECTION  #################################


-- ########################  LIVE SECTION  ####################################
-- NOT WRITTEN AS RUNNABLE DDL YET — deliberately. The live identity anchor must
-- reconcile with LandIQ's existing auth (profiles/roles/RLS) in this shared
-- project first (THE SEAM above), so writing executable LIVE SQL now would risk a
-- parallel model inside one project. When LandIQ's schema has been read, the LIVE
-- section mirrors the DEV section with these REQUIREMENTS baked in (same as the
-- corrected DEV section — do not drop any):
--   * same 8 tables WITHOUT the dev_ prefix.
--   * ENABLE ROW LEVEL SECURITY on ALL 8 (deny-all) — including roles,
--     permissions, role_permissions, modules (the authorization tables).
--   * wire app_users.auth_user_id -> auth.users(id); decide reuse-LandIQ-profiles
--     vs keep app_users; map LandIQ's roles into `roles`; compose RLS with LandIQ's.
--   * house new-table checklist for anything the app will READ: GRANT to
--     service_role (nothing reads these in phase (a), so deferred — see backlog).
--   * FINAL LINE: NOTIFY pgrst, 'reload schema';
-- This runs at the phase-(a) promote, AFTER the LandIQ read.
-- ============================================================================
