-- ============================================================================
-- Fix: Add Builder failed on Dev because the 8 new dev_field_ops_ foundation tables
-- have NO DML privileges for service_role (they were created with only
-- REFERENCES/TRIGGER/TRUNCATE by default). service_role BYPASSES RLS, but RLS bypass
-- is NOT table privilege — the role still needs SELECT/INSERT/UPDATE/DELETE grants to
-- read/write. Without them the atomic create-builder function's INSERTs raised and the
-- whole transaction rolled back (ZZ_Test left 0 rows — atomicity held, but no builder).
--
-- This grants service_role the MINIMAL privilege each table needs — DML on the tables
-- the app writes per-user, SELECT on the seeded config/lookup tables. NO anon /
-- authenticated grants (those roles stay denied by RLS-deny-all). Idempotent.
--
-- Run ONCE on Dev. The same grants are mirrored into the foundation migration's DEV +
-- LIVE sections so a fresh apply is complete and Dev/live cannot drift.
-- ============================================================================


-- ####################  PRE-CHECK (read-only) — see the gap  #################
-- Expect DML privileges to be ABSENT before the grants (likely only REFERENCES/
-- TRIGGER/TRUNCATE, or nothing). Run, eyeball, then run the GRANTS below.
/*
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS service_role_privs
FROM information_schema.role_table_grants
WHERE grantee='service_role' AND table_schema='public'
  AND table_name IN (
    'dev_field_ops_users','dev_field_ops_roles','dev_field_ops_permissions',
    'dev_field_ops_role_permissions','dev_field_ops_user_roles',
    'dev_field_ops_user_permission_overrides','dev_field_ops_modules','dev_field_ops_user_subdivisions')
GROUP BY table_name ORDER BY table_name;
*/


-- ########################  GRANTS (run once)  ###############################
-- Per table, minimal privilege for its role in the model:

-- users: the app CREATES users (create-builder), reads them (login/guard), UPDATES
--   status (blocker 2 suspend/reactivate), and DELETEs in test cleanup.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dev_field_ops_users                     TO service_role;

-- user_roles: assign (INSERT) / read (SELECT) / remove (DELETE) roles. Join table, no UPDATE.
GRANT SELECT, INSERT, DELETE         ON public.dev_field_ops_user_roles                 TO service_role;

-- roles: SEEDED config. Create-builder only looks up role_id by key → SELECT only.
GRANT SELECT                         ON public.dev_field_ops_roles                      TO service_role;

-- permissions: SEEDED config. The resolver reads it → SELECT only.
GRANT SELECT                         ON public.dev_field_ops_permissions                TO service_role;

-- role_permissions: SEEDED bundle. Resolver reads it → SELECT only.
--   (roles.manage will later need DML here; grant then, per the house rule.)
GRANT SELECT                         ON public.dev_field_ops_role_permissions           TO service_role;

-- modules: SEEDED config. Gating reads module->required_permission → SELECT only.
GRANT SELECT                         ON public.dev_field_ops_modules                    TO service_role;

-- user_permission_overrides: per-user grant/deny escape hatch — admin manages → full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dev_field_ops_user_permission_overrides  TO service_role;

-- user_subdivisions: per-user subdivision assignment — manager/admin manages → full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dev_field_ops_user_subdivisions          TO service_role;

NOTIFY pgrst, 'reload schema';

-- ########################  END GRANTS  ######################################


-- ####################  VERIFICATION — run after. Expect 8 rows, all PASS.  ##
/*
WITH want(table_name, n) AS (VALUES
  ('dev_field_ops_users',4),
  ('dev_field_ops_user_roles',3),
  ('dev_field_ops_roles',1),
  ('dev_field_ops_permissions',1),
  ('dev_field_ops_role_permissions',1),
  ('dev_field_ops_modules',1),
  ('dev_field_ops_user_permission_overrides',4),
  ('dev_field_ops_user_subdivisions',4)
),
got AS (
  SELECT table_name, count(*)::int n
  FROM information_schema.role_table_grants
  WHERE grantee='service_role' AND table_schema='public'
    AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
    AND table_name IN (SELECT table_name FROM want)
  GROUP BY table_name
)
SELECT w.table_name, COALESCE(g.n,0) AS actual, w.n AS expected,
       CASE WHEN COALESCE(g.n,0)=w.n THEN 'PASS' ELSE 'FAIL' END AS status
FROM want w LEFT JOIN got g USING (table_name)
ORDER BY w.table_name;
*/
-- ============================================================================
