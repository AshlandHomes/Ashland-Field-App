-- ============================================================================
-- Manager view — S2: server permission gate. Dev only.
-- ---------------------------------------------------------------------------
-- IMPORTANT (verified against 2026-09-26_permission_foundation_fieldops.sql):
--   The 'manager_view.use' PERMISSION is ALREADY seeded (:141), ALREADY granted to
--   field_manager (:156) and super_user (:157 = all perms), and the 'manager_view'
--   MODULE is ALREADY linked to it (:164). So the permission/grant/link are NOT new
--   work on a Dev DB that ran the foundation migration. This file therefore ENSURES
--   that end state idempotently (ON CONFLICT DO NOTHING / guarded UPDATE — no-ops on
--   Dev), and the only genuinely NEW row is ONE test manager.
--
-- This is DML seed data (not DDL), so ON CONFLICT DO NOTHING is the correct idempotent
-- pattern (the foundation migration uses it too) — the "no IF NOT EXISTS / no CREATE OR
-- REPLACE" rule governs DDL, which this file has none of. Pre-check RAISEs only on the
-- real collision risk: the 'Test Manager' name clashing with a builder or another user.
-- Field-ops-owned tables only; ZERO LandIQ tables.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. Existing permission keys — confirm 'manager_view.use' is present (do not duplicate).
/*
SELECT key FROM public.dev_field_ops_permissions ORDER BY key;
*/
-- A2. The manager_view module row — note whether required_permission_id is already linked.
/*
SELECT m.key, m.name, m.enabled, m.required_permission_id, p.key AS linked_permission
FROM public.dev_field_ops_modules m
LEFT JOIN public.dev_field_ops_permissions p ON p.id = m.required_permission_id
WHERE m.key = 'manager_view';
*/
-- A3. Who already holds manager_view.use (expect field_manager + super_user).
/*
SELECT r.key AS role
FROM public.dev_field_ops_role_permissions rp
JOIN public.dev_field_ops_roles r ON r.id = rp.role_id
JOIN public.dev_field_ops_permissions p ON p.id = rp.permission_id
WHERE p.key = 'manager_view.use' ORDER BY r.key;
*/
-- A4. 'Test Manager' must NOT collide with any builder name or user display_name (expect 0 rows).
/*
SELECT 'builder' AS src, name AS nm FROM public.dev_field_ops_builders WHERE name = 'Test Manager'
UNION ALL
SELECT 'user' AS src, display_name FROM public.dev_field_ops_users WHERE display_name = 'Test Manager';
*/


-- ####################  BLOCK B — SEED (run once)  ###########################
BEGIN;

DO $$
DECLARE
  v_perm_id uuid;
  v_fm      uuid;
  v_su      uuid;
  v_uid     uuid;
BEGIN
  -- Prerequisites (from the foundation migration).
  SELECT id INTO v_fm FROM public.dev_field_ops_roles WHERE key = 'field_manager';
  SELECT id INTO v_su FROM public.dev_field_ops_roles WHERE key = 'super_user';
  IF v_fm IS NULL OR v_su IS NULL THEN
    RAISE EXCEPTION 'ABORT: field_manager/super_user role missing — run the permission foundation first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dev_field_ops_modules WHERE key = 'manager_view') THEN
    RAISE EXCEPTION 'ABORT: module manager_view missing — run the permission foundation first.';
  END IF;
  -- Real collision risk: the test manager name must be unique across builders AND users.
  IF EXISTS (SELECT 1 FROM public.dev_field_ops_builders WHERE name = 'Test Manager')
     OR EXISTS (SELECT 1 FROM public.dev_field_ops_users WHERE display_name = 'Test Manager') THEN
    RAISE EXCEPTION 'ABORT: name "Test Manager" already exists as a builder or user.';
  END IF;

  -- ENSURE the permission exists (no-op if the foundation already seeded it).
  INSERT INTO public.dev_field_ops_permissions (key, description)
  VALUES ('manager_view.use', 'Use the manager view')
  ON CONFLICT (key) DO NOTHING;
  SELECT id INTO v_perm_id FROM public.dev_field_ops_permissions WHERE key = 'manager_view.use';

  -- ENSURE it is granted to field_manager + super_user (no-op if already granted).
  INSERT INTO public.dev_field_ops_role_permissions (role_id, permission_id)
  VALUES (v_fm, v_perm_id), (v_su, v_perm_id)
  ON CONFLICT DO NOTHING;

  -- ENSURE the module gate points at it (no-op if already linked).
  UPDATE public.dev_field_ops_modules
     SET required_permission_id = v_perm_id
   WHERE key = 'manager_view' AND required_permission_id IS DISTINCT FROM v_perm_id;

  -- NEW: seed ONE test manager (person-only; no builder row). field_manager role.
  v_uid := gen_random_uuid();
  INSERT INTO public.dev_field_ops_users (id, display_name, status) VALUES (v_uid, 'Test Manager', 'active');
  INSERT INTO public.dev_field_ops_user_roles (user_id, role_id) VALUES (v_uid, v_fm);
  -- Temp PIN 2468 (hashed via the S1b RPC; manager changes it on first login). Not 0000/1234/repeat.
  PERFORM public.dev_field_ops_set_pin(v_uid, '2468', true, true);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ####################  END SEED  ############################################


-- ####################  BLOCK C — VERIFICATION. Expect 7 rows, all PASS.  ####
/*
WITH perm AS (SELECT id FROM public.dev_field_ops_permissions WHERE key='manager_view.use'),
checks AS (
            SELECT 'permission_exists' AS check_name, (SELECT count(*) FROM perm)::text AS actual, '1' AS expected
  UNION ALL SELECT 'granted_count_is_two',
                   (SELECT count(*) FROM public.dev_field_ops_role_permissions WHERE permission_id = (SELECT id FROM perm))::text, '2'
  UNION ALL SELECT 'granted_roles_are_fm_su',
                   (SELECT count(*) FROM public.dev_field_ops_role_permissions rp
                     JOIN public.dev_field_ops_roles r ON r.id = rp.role_id
                     WHERE rp.permission_id = (SELECT id FROM perm) AND r.key IN ('field_manager','super_user'))::text, '2'
  UNION ALL SELECT 'module_linked',
                   (SELECT (required_permission_id = (SELECT id FROM perm)) FROM public.dev_field_ops_modules WHERE key='manager_view')::text, 'true'
  UNION ALL SELECT 'test_manager_exists',
                   (SELECT count(*) FROM public.dev_field_ops_users WHERE display_name='Test Manager')::text, '1'
  UNION ALL SELECT 'test_manager_has_fm_role',
                   (SELECT count(*) FROM public.dev_field_ops_user_roles ur
                     JOIN public.dev_field_ops_users u ON u.id = ur.user_id
                     JOIN public.dev_field_ops_roles r ON r.id = ur.role_id
                     WHERE u.display_name='Test Manager' AND r.key='field_manager')::text, '1'
  UNION ALL SELECT 'test_manager_has_temp_pin',
                   (SELECT (temp_pin_hash IS NOT NULL AND pin_hash IS NULL)
                      FROM public.dev_field_ops_users WHERE display_name='Test Manager')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed — removes the test manager)  #
-- Leaves the permission/grant/module link in place (they are foundation seed, not ours).
/*
BEGIN;
DELETE FROM public.dev_field_ops_user_roles
 WHERE user_id = (SELECT id FROM public.dev_field_ops_users WHERE display_name='Test Manager');
DELETE FROM public.dev_field_ops_users WHERE display_name='Test Manager';
COMMIT;
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
