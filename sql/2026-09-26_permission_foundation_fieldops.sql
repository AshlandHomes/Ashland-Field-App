-- ============================================================================
-- Permission / Module FOUNDATION v2 — field_ops_ namespace (phase (a), rebuilt)
--
-- Replaces the RETRACTED sql/2026-09-24_permission_foundation.sql after the
-- 2026-09-26 LandIQ collision. This DB is SHARED with LandIQ; `dev_` isolates dev
-- from live ONLY, not from LandIQ. So:
--   * Every table lives in the FIELD APP's OWN namespace: field_ops_  (dev_field_ops_ on Dev).
--   * ZERO references to any LandIQ table. Our own users table (field_ops_users) —
--     we NEVER touch LandIQ's app_users.
--   * plain CREATE TABLE (NOT "IF NOT EXISTS") + a pre-flight that RAISES if any
--     target name already exists, so a collision ERRORS instead of silently adopting.
--   * The whole DEV SECTION is one transaction (BEGIN…COMMIT) — a failure (pre-flight
--     RAISE or a CREATE hitting an existing name) leaves NOTHING half-built.
--   * ADDITIVE ONLY. Nothing reads/enforces these yet. Existing PIN auth untouched.
--
-- IDENTITY MODEL (corrected; from the incident §5):
--   * "Unified identity" is unified at Supabase auth.users ONLY (one auth.users per
--     project, inherently shared with LandIQ). NOT unified at the profile layer:
--     LandIQ has app_users; WE have field_ops_users. Each app maps auth.users -> own profile.
--   * field_ops_users.auth_user_id is a PLAIN uuid (NO foreign key) — we map to
--     auth.users, we do not hard-depend on or cascade with it.
--   * BUILDERS are PIN-only, NO auth.users row (auth_user_id NULL). Zero shared-auth footprint.
--   * MANAGERS/ADMINS log in by email -> an auth.users row (shared) -> mapped via auth_user_id.
--     We NEVER create, alter, or delete auth.users rows.
--
-- ISOLATION: dev/live by TABLE_PREFIX. Run the DEV SECTION on Dev now. The LIVE
-- section is the identical block with dev_ removed; runs at promote after Dev verified.
-- ============================================================================


-- ########################  DEV SECTION (run now)  ###########################
BEGIN;

-- 0) PRE-FLIGHT — abort the whole transaction if ANY target name already exists
--    (shared DB). This is the guard the retracted migration lacked.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dev_field_ops_users','dev_field_ops_roles','dev_field_ops_permissions',
    'dev_field_ops_role_permissions','dev_field_ops_user_roles',
    'dev_field_ops_user_permission_overrides','dev_field_ops_modules',
    'dev_field_ops_user_subdivisions'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=t) THEN
      RAISE EXCEPTION 'ABORT: table % already exists — inventory before DDL (DB shared with LandIQ)', t;
    END IF;
  END LOOP;
END $$;

-- 1) OUR OWN UNIFIED USER (never LandIQ's app_users) -------------------------
CREATE TABLE dev_field_ops_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid,                                   -- PLAIN map to auth.users(id); NO FK. NULL for PIN-only builders.
  display_name  text NOT NULL,
  email         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dev_field_ops_users ENABLE ROW LEVEL SECURITY;   -- deny-all; service key bypasses

-- 2) ROLES -------------------------------------------------------------------
CREATE TABLE dev_field_ops_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,                     -- builder | admin | field_manager | super_user
  name        text NOT NULL,
  description text
);
ALTER TABLE dev_field_ops_roles ENABLE ROW LEVEL SECURITY;

-- 3) PERMISSIONS -------------------------------------------------------------
CREATE TABLE dev_field_ops_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,
  description text
);
ALTER TABLE dev_field_ops_permissions ENABLE ROW LEVEL SECURITY;

-- 4) ROLE -> PERMISSIONS (the bundle) ---------------------------------------
CREATE TABLE dev_field_ops_role_permissions (
  role_id       uuid NOT NULL REFERENCES dev_field_ops_roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES dev_field_ops_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
ALTER TABLE dev_field_ops_role_permissions ENABLE ROW LEVEL SECURITY;

-- 5) USER -> ROLES (multi-role = union) -------------------------------------
CREATE TABLE dev_field_ops_user_roles (
  user_id uuid NOT NULL REFERENCES dev_field_ops_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES dev_field_ops_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
ALTER TABLE dev_field_ops_user_roles ENABLE ROW LEVEL SECURITY;

-- 6) USER -> PERMISSION OVERRIDES (per-user grant/deny) ----------------------
CREATE TABLE dev_field_ops_user_permission_overrides (
  user_id       uuid NOT NULL REFERENCES dev_field_ops_users(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES dev_field_ops_permissions(id) ON DELETE CASCADE,
  effect        text NOT NULL CHECK (effect IN ('grant','deny')),
  PRIMARY KEY (user_id, permission_id)
);
ALTER TABLE dev_field_ops_user_permission_overrides ENABLE ROW LEVEL SECURITY;

-- 7) MODULES (each surface, permission-gated, individually on/off) -----------
CREATE TABLE dev_field_ops_modules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                    text UNIQUE NOT NULL,          -- field_app | admin_console | manager_view | punch_system
  name                   text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  required_permission_id uuid REFERENCES dev_field_ops_permissions(id)
);
ALTER TABLE dev_field_ops_modules ENABLE ROW LEVEL SECURITY;

-- 8) MANAGER (and later builder) SUBDIVISION ASSIGNMENT ----------------------
CREATE TABLE dev_field_ops_user_subdivisions (
  user_id          uuid NOT NULL REFERENCES dev_field_ops_users(id) ON DELETE CASCADE,
  subdivision_code text NOT NULL,                       -- community code (e.g. 'CT')
  PRIMARY KEY (user_id, subdivision_code)
);
ALTER TABLE dev_field_ops_user_subdivisions ENABLE ROW LEVEL SECURITY;

-- 9) The builder link column dev_field_ops_builders.user_id already exists (kept
--    from the retracted run). Its FK -> dev_field_ops_users(id) + UNIQUE are added
--    with the backfill (phase b), so the column can be populated first.


-- ####################  SEED the roles / permissions / modules  ##############

INSERT INTO dev_field_ops_roles (key, name, description) VALUES
  ('builder',       'Builder',       'Field app: own lots'),
  ('admin',         'Admin',         'Admin console + user/role/module management'),
  ('field_manager', 'Field Manager', 'Manager view + punch/checklist'),
  ('super_user',    'Super User',    'All modules and management')
ON CONFLICT (key) DO NOTHING;

INSERT INTO dev_field_ops_permissions (key, description) VALUES
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
-- NOTE (backlog): builders need a punch.respond-type permission — punch_system is
-- gated on punch.create, which builders lack. Resolve when the punch system is built.

INSERT INTO dev_field_ops_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM dev_field_ops_roles r, dev_field_ops_permissions p WHERE
     (r.key='builder'       AND p.key IN ('field_app.use','schedule.edit'))
  OR (r.key='admin'         AND p.key IN ('admin_console.use','users.manage','modules.manage','roles.manage','schedule.edit'))
  OR (r.key='field_manager' AND p.key IN ('manager_view.use','punch.create','punch.verify'))
  OR (r.key='super_user')                                          -- super_user = every permission
ON CONFLICT DO NOTHING;

INSERT INTO dev_field_ops_modules (key, name, enabled, required_permission_id)
SELECT m.key, m.name, true, p.id FROM (VALUES
    ('field_app',     'Field App',        'field_app.use'),
    ('admin_console', 'Admin Console',    'admin_console.use'),
    ('manager_view',  'Manager View',     'manager_view.use'),
    ('punch_system',  'Punch / Checklist','punch.create')
  ) AS m(key, name, perm)
  JOIN dev_field_ops_permissions p ON p.key = m.perm
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- After COMMIT: make PostgREST see the new tables.
NOTIFY pgrst, 'reload schema';

-- ########################  END DEV SECTION  #################################


-- ####################  VERIFICATION — ONE combined query  ###################
-- The editor shows only the LAST result, so this is a single query returning
-- check_name | actual | expected | status. Expect EXACTLY 12 rows, all PASS.
-- (12 = 5 counts + 4 per-role + rls + link-column + fk-invariant; a missing row
-- means a table/CREATE didn't land.)
/*
WITH checks AS (
            SELECT 'users_count'            AS check_name, (SELECT count(*) FROM dev_field_ops_users)::text            AS actual, '0'  AS expected
  UNION ALL SELECT 'roles_count',            (SELECT count(*) FROM dev_field_ops_roles)::text,            '4'
  UNION ALL SELECT 'permissions_count',      (SELECT count(*) FROM dev_field_ops_permissions)::text,      '9'
  UNION ALL SELECT 'role_permissions_count', (SELECT count(*) FROM dev_field_ops_role_permissions)::text, '19'   -- 2+5+3+9
  UNION ALL SELECT 'modules_count',          (SELECT count(*) FROM dev_field_ops_modules)::text,          '4'
  UNION ALL SELECT 'rp_admin',         (SELECT count(*) FROM dev_field_ops_role_permissions rp JOIN dev_field_ops_roles r ON r.id=rp.role_id WHERE r.key='admin')::text,         '5'
  UNION ALL SELECT 'rp_builder',       (SELECT count(*) FROM dev_field_ops_role_permissions rp JOIN dev_field_ops_roles r ON r.id=rp.role_id WHERE r.key='builder')::text,       '2'
  UNION ALL SELECT 'rp_field_manager', (SELECT count(*) FROM dev_field_ops_role_permissions rp JOIN dev_field_ops_roles r ON r.id=rp.role_id WHERE r.key='field_manager')::text, '3'
  UNION ALL SELECT 'rp_super_user',    (SELECT count(*) FROM dev_field_ops_role_permissions rp JOIN dev_field_ops_roles r ON r.id=rp.role_id WHERE r.key='super_user')::text,    '9'
  UNION ALL SELECT 'rls_enabled_on_all_8', (SELECT count(*) FROM pg_class WHERE relkind='r' AND relrowsecurity AND relname IN
        ('dev_field_ops_users','dev_field_ops_roles','dev_field_ops_permissions','dev_field_ops_role_permissions',
         'dev_field_ops_user_roles','dev_field_ops_user_permission_overrides','dev_field_ops_modules','dev_field_ops_user_subdivisions'))::text, '8'
  UNION ALL SELECT 'builder_user_id_col', (SELECT count(*) FROM information_schema.columns WHERE table_name='dev_field_ops_builders' AND column_name='user_id')::text, '1'
  UNION ALL SELECT 'fk_out_of_namespace', (SELECT count(*) FROM pg_constraint WHERE contype='f'
         AND conrelid::regclass::text LIKE 'dev_field_ops_%'
         AND confrelid::regclass::text NOT LIKE 'dev_field_ops_%')::text, '0'   -- every FK from ours must point INTO ours
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/

-- ########################  LIVE SECTION  ####################################
-- Runs at promote, AFTER Dev is verified. It is the DEV SECTION with the dev_
-- prefix removed everywhere (pre-flight array, CREATEs, ALTERs, seeds, verification)
-- targeting field_ops_users, field_ops_roles, ... . No LandIQ reconciliation is
-- needed (we reference none of their tables). Written out in full at promote so DEV
-- and LIVE cannot drift; the house new-table checklist (GRANT to service_role) is
-- added then, for anything the app will read (see ENHANCEMENT_BACKLOG.md).
-- ============================================================================
