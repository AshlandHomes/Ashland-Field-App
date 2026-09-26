-- ============================================================================
-- Step (b) — INVISIBLE BUILDER BACKFILL (DEV). Run ONCE, in one transaction.
--
-- Maps every dev_field_ops_builders row to a dev_field_ops_users row and assigns
-- its role, WITHOUT touching PIN login (online or offline) — see the login-path
-- proof in SESSION_NOTES / the step-(b) plan. Shared DB: every table here is
-- dev_field_ops_*; auth_user_id stays NULL (builders are PIN-only, we never read
-- or write auth.users or any LandIQ table).
--
-- DECISIONS baked in (Dev, 7 builders; only "Admin" is is_admin):
--   D1 = (B) is_admin builder -> ADMIN role only; non-admin -> BUILDER only.
--   D2 = all builders backfilled, status 'active' (is_locked is transient; none locked).
--   D3 = no other inactive flag; all 7 backfilled. No super_user (preserve today's access).
--
-- LINK BY CONSTRUCTION (no string matching): assign each unlinked builder a fresh
-- uuid, then create the user row with THAT id. 1:1 by design, idempotent (only
-- unlinked builders / missing users are touched). FK + UNIQUE added AFTER the data.
--
-- LIVE runs at promote, after the step-(a) LIVE foundation exists — same block with
-- the dev_ prefix removed.
-- ============================================================================


-- ########################  DEV SECTION (run once)  ##########################
BEGIN;

-- 1) assign a user id to every unlinked builder BY CONSTRUCTION.
UPDATE dev_field_ops_builders
   SET user_id = gen_random_uuid()
 WHERE user_id IS NULL;

-- 2) create the matching user for each linked builder that doesn't have one yet.
INSERT INTO dev_field_ops_users (id, display_name, auth_user_id, email, status)
SELECT b.user_id, b.name, NULL, NULL, 'active'
FROM dev_field_ops_builders b
WHERE b.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM dev_field_ops_users u WHERE u.id = b.user_id);

-- 3) roles per D1 (mutually exclusive; NULL is_admin treated as non-admin).
INSERT INTO dev_field_ops_user_roles (user_id, role_id)          -- BUILDER for non-admins
SELECT b.user_id, r.id
FROM dev_field_ops_builders b
JOIN dev_field_ops_roles r ON r.key = 'builder'
WHERE b.is_admin IS DISTINCT FROM true AND b.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dev_field_ops_user_roles (user_id, role_id)          -- ADMIN for is_admin
SELECT b.user_id, r.id
FROM dev_field_ops_builders b
JOIN dev_field_ops_roles r ON r.key = 'admin'
WHERE b.is_admin IS TRUE AND b.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4) integrity: FK + UNIQUE on the link column (guarded so a re-run doesn't error).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dev_field_ops_builders_user_id_fkey') THEN
    ALTER TABLE dev_field_ops_builders
      ADD CONSTRAINT dev_field_ops_builders_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES dev_field_ops_users(id);   -- NO ACTION on delete
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dev_field_ops_builders_user_id_key') THEN
    ALTER TABLE dev_field_ops_builders
      ADD CONSTRAINT dev_field_ops_builders_user_id_key UNIQUE (user_id);  -- 1 user per builder; NULLs allowed
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';   -- user_id/users now populated; refresh the API view

-- ########################  END DEV SECTION  #################################


-- ####################  VERIFICATION — ONE combined query  ###################
-- Run after. Expect EXACTLY 9 rows, all PASS.
/*
WITH checks AS (
            SELECT 'users_count' check_name, (SELECT count(*) FROM dev_field_ops_users)::text actual, '7' expected
  UNION ALL SELECT 'builder_role_assignments', (SELECT count(*) FROM dev_field_ops_user_roles ur JOIN dev_field_ops_roles r ON r.id=ur.role_id WHERE r.key='builder')::text, '6'
  UNION ALL SELECT 'admin_role_assignments',   (SELECT count(*) FROM dev_field_ops_user_roles ur JOIN dev_field_ops_roles r ON r.id=ur.role_id WHERE r.key='admin')::text, '1'
  UNION ALL SELECT 'admin_role_only_on_is_admin',                       -- admin role sitting on a non-admin builder = violation
     (SELECT count(*) FROM dev_field_ops_user_roles ur
        JOIN dev_field_ops_roles r ON r.id=ur.role_id AND r.key='admin'
        JOIN dev_field_ops_builders b ON b.user_id = ur.user_id
       WHERE b.is_admin IS DISTINCT FROM true)::text, '0'
  UNION ALL SELECT 'builders_with_null_user', (SELECT count(*) FROM dev_field_ops_builders WHERE user_id IS NULL)::text, '0'
  UNION ALL SELECT 'user_not_from_exactly_one_builder',                 -- every user linked from exactly one builder
     (SELECT count(*) FROM dev_field_ops_users u
       WHERE (SELECT count(*) FROM dev_field_ops_builders b WHERE b.user_id = u.id) <> 1)::text, '0'
  UNION ALL SELECT 'fk_exists',     EXISTS(SELECT 1 FROM pg_constraint WHERE conname='dev_field_ops_builders_user_id_fkey')::text, 'true'
  UNION ALL SELECT 'unique_exists', EXISTS(SELECT 1 FROM pg_constraint WHERE conname='dev_field_ops_builders_user_id_key')::text, 'true'
  UNION ALL SELECT 'fk_out_of_namespace', (SELECT count(*) FROM pg_constraint WHERE contype='f'
         AND conrelid::regclass::text LIKE 'dev_field_ops_%'
         AND confrelid::regclass::text NOT LIKE 'dev_field_ops_%')::text, '0'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
-- SCOPED to builder-linked users only — captures those ids FIRST, never an
-- unconditional DELETE FROM dev_field_ops_users.
/*
BEGIN;
CREATE TEMP TABLE _bkfill_ids ON COMMIT DROP AS
  SELECT user_id AS id FROM dev_field_ops_builders WHERE user_id IS NOT NULL;

ALTER TABLE dev_field_ops_builders DROP CONSTRAINT IF EXISTS dev_field_ops_builders_user_id_key;
ALTER TABLE dev_field_ops_builders DROP CONSTRAINT IF EXISTS dev_field_ops_builders_user_id_fkey;

DELETE FROM dev_field_ops_user_roles WHERE user_id IN (SELECT id FROM _bkfill_ids);
UPDATE dev_field_ops_builders SET user_id = NULL;
DELETE FROM dev_field_ops_users  WHERE id IN (SELECT id FROM _bkfill_ids);
COMMIT;
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
