-- ============================================================================
-- Manager view — S1b: login + PIN writes read/write the PERSON (dev_field_ops_users),
-- hashed, via SECURITY DEFINER RPCs. The compare happens in Postgres (pgcrypto crypt);
-- a hash NEVER leaves the database. ONE login for everyone.
-- ---------------------------------------------------------------------------
-- Three functions (all dev_ only this step; no live mirror):
--   * dev_field_ops_verify_login(uuid, text)  — atomic: lock check → crypt compare →
--       on success reset attempts; on failure increment + lock at 5. Returns jsonb
--       { valid, is_temp, is_locked, reason, attempts_left, roles[] }. NEVER a hash.
--   * dev_field_ops_set_pin(uuid, text, boolean, boolean) — hashes in-DB, clears the
--       OTHER pin field (perm vs temp), optionally resets attempts/lock (p_reset_lock).
--   * dev_field_ops_unlock_user(uuid) — clears is_locked + failed_attempts.
--
-- DISCIPLINE: plain CREATE FUNCTION (NO CREATE OR REPLACE) behind a DO-block pre-check
-- that RAISEs if any of the three names already exists; SECURITY DEFINER; search_path
-- pinned to public, extensions, pg_temp (pgcrypto lives in "extensions" on this project);
-- EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role only.
-- Field-ops-owned objects; ZERO LandIQ tables. Depends on S1a columns (pin_hash,
-- temp_pin_hash, failed_attempts, is_locked on dev_field_ops_users).
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. None of the three function names may already exist (expect 0 rows).
/*
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('dev_field_ops_verify_login','dev_field_ops_set_pin','dev_field_ops_unlock_user')
ORDER BY p.proname;
*/
-- A2. S1a columns must be present on dev_field_ops_users (expect 4 rows).
/*
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_field_ops_users'
  AND column_name IN ('pin_hash','temp_pin_hash','failed_attempts','is_locked')
ORDER BY column_name;
*/
-- A3. pgcrypto must be resolvable (expect 1 row; schema 'extensions').
/*
SELECT e.extname, n.nspname AS schema FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname='pgcrypto';
*/


-- ####################  BLOCK B — FUNCTIONS (run once)  ######################
BEGIN;

-- Pre-flight: none of the three may already exist (any signature); S1a columns required.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public'
                AND p.proname IN ('dev_field_ops_verify_login','dev_field_ops_set_pin','dev_field_ops_unlock_user')) THEN
    RAISE EXCEPTION 'ABORT: one of the three login functions already exists — drop it explicitly before re-creating (no CREATE OR REPLACE).';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='dev_field_ops_users'
         AND column_name IN ('pin_hash','temp_pin_hash','failed_attempts','is_locked')) <> 4 THEN
    RAISE EXCEPTION 'ABORT: S1a credential columns missing on dev_field_ops_users — run 2026-10-10_users_pin_login.sql first.';
  END IF;
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL AND to_regprocedure('public.crypt(text, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: pgcrypto crypt() not found in extensions or public.';
  END IF;
END $$;

-- 1) VERIFY LOGIN — the only PIN-compare path. Atomic lock/compare/attempts.
CREATE FUNCTION public.dev_field_ops_verify_login(p_user_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_pin_hash  text;
  v_temp_hash text;
  v_attempts  integer;
  v_locked    boolean;
  v_is_temp   boolean := false;
  v_ok        boolean := false;
  v_roles     jsonb;
BEGIN
  SELECT pin_hash, temp_pin_hash, failed_attempts, is_locked
    INTO v_pin_hash, v_temp_hash, v_attempts, v_locked
    FROM public.dev_field_ops_users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid',false,'is_temp',false,'is_locked',false,
                              'reason','user_not_found','attempts_left',0,'roles','[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(r.key ORDER BY r.key), '[]'::jsonb) INTO v_roles
  FROM public.dev_field_ops_user_roles ur
  JOIN public.dev_field_ops_roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  IF v_locked THEN
    RETURN jsonb_build_object('valid',false,'is_temp',false,'is_locked',true,
                              'reason','locked','attempts_left',0,'roles',v_roles);
  END IF;

  v_is_temp := (v_temp_hash IS NOT NULL AND crypt(p_pin, v_temp_hash) = v_temp_hash);
  v_ok      := v_is_temp OR (v_pin_hash IS NOT NULL AND crypt(p_pin, v_pin_hash) = v_pin_hash);

  IF v_ok THEN
    UPDATE public.dev_field_ops_users
       SET failed_attempts = 0, updated_at = now()
     WHERE id = p_user_id;
    RETURN jsonb_build_object('valid',true,'is_temp',v_is_temp,'is_locked',false,
                              'reason',NULL,'attempts_left',5,'roles',v_roles);
  END IF;

  v_attempts := COALESCE(v_attempts,0) + 1;
  v_locked   := v_attempts >= 5;
  UPDATE public.dev_field_ops_users
     SET failed_attempts = v_attempts, is_locked = v_locked, updated_at = now()
   WHERE id = p_user_id;
  RETURN jsonb_build_object('valid',false,'is_temp',false,'is_locked',v_locked,
                            'reason','wrong_pin','attempts_left',GREATEST(0, 5 - v_attempts),'roles',v_roles);
END;
$$;

-- 2) SET PIN — hashes in-DB; clears the other field; optional lock reset.
--    p_reset_lock=true  => first-login self-set (mirrors old setBuilderPin: resets+unlocks)
--    p_reset_lock=false => admin "Set PIN" (mirrors old updateBuilderPin: leaves lock as-is)
CREATE FUNCTION public.dev_field_ops_set_pin(
  p_user_id uuid, p_pin text, p_is_temp boolean, p_reset_lock boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF p_pin IS NULL OR p_pin = '' THEN RAISE EXCEPTION 'pin required'; END IF;
  UPDATE public.dev_field_ops_users
     SET pin_hash        = CASE WHEN p_is_temp THEN NULL ELSE crypt(p_pin, gen_salt('bf')) END,
         temp_pin_hash   = CASE WHEN p_is_temp THEN crypt(p_pin, gen_salt('bf')) ELSE NULL END,
         failed_attempts = CASE WHEN p_reset_lock THEN 0 ELSE failed_attempts END,
         is_locked       = CASE WHEN p_reset_lock THEN false ELSE is_locked END,
         updated_at      = now()
   WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'user % not found', p_user_id; END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 3) UNLOCK — clear lock + attempts.
CREATE FUNCTION public.dev_field_ops_unlock_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  UPDATE public.dev_field_ops_users
     SET is_locked = false, failed_attempts = 0, updated_at = now()
   WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'user % not found', p_user_id; END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- GRANTS — service_role only (BYPASSRLS is not EXECUTE privilege). No PUBLIC/anon/auth.
REVOKE EXECUTE ON FUNCTION public.dev_field_ops_verify_login(uuid, text)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dev_field_ops_set_pin(uuid, text, boolean, boolean)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dev_field_ops_unlock_user(uuid)                        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_verify_login(uuid, text)                 TO service_role;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_set_pin(uuid, text, boolean, boolean)    TO service_role;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_unlock_user(uuid)                        TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ####################  END FUNCTIONS  #######################################


-- ####################  BLOCK C1 — SECURITY VERIFICATION. Expect 6, all PASS.  ####
/*
WITH checks AS (
            SELECT 'all_three_exist' AS check_name,
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public'
                       AND p.proname IN ('dev_field_ops_verify_login','dev_field_ops_set_pin','dev_field_ops_unlock_user'))::text AS actual,
                   '3' AS expected
  UNION ALL SELECT 'all_security_definer',
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.prosecdef
                       AND p.proname IN ('dev_field_ops_verify_login','dev_field_ops_set_pin','dev_field_ops_unlock_user'))::text, '3'
  UNION ALL SELECT 'all_search_path_pinned',
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public'
                       AND p.proname IN ('dev_field_ops_verify_login','dev_field_ops_set_pin','dev_field_ops_unlock_user')
                       AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%'))::text, '3'
  UNION ALL SELECT 'service_role_execute_all',
                   (has_function_privilege('service_role','public.dev_field_ops_verify_login(uuid, text)','EXECUTE')
                AND has_function_privilege('service_role','public.dev_field_ops_set_pin(uuid, text, boolean, boolean)','EXECUTE')
                AND has_function_privilege('service_role','public.dev_field_ops_unlock_user(uuid)','EXECUTE'))::text, 'true'
  UNION ALL SELECT 'anon_no_execute',
                   (has_function_privilege('anon','public.dev_field_ops_verify_login(uuid, text)','EXECUTE')
                 OR has_function_privilege('anon','public.dev_field_ops_set_pin(uuid, text, boolean, boolean)','EXECUTE')
                 OR has_function_privilege('anon','public.dev_field_ops_unlock_user(uuid)','EXECUTE'))::text, 'false'
  UNION ALL SELECT 'authenticated_no_execute',
                   (has_function_privilege('authenticated','public.dev_field_ops_verify_login(uuid, text)','EXECUTE')
                 OR has_function_privilege('authenticated','public.dev_field_ops_set_pin(uuid, text, boolean, boolean)','EXECUTE')
                 OR has_function_privilege('authenticated','public.dev_field_ops_unlock_user(uuid)','EXECUTE'))::text, 'false'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  BLOCK C2 — FUNCTIONAL TEST (atomic; self-cleaning)  ##
-- Creates a throwaway user, exercises correct/wrong/temp PINs + lockout, then DELETEs it.
-- The whole DO block is one statement: if any assertion RAISEs, the insert rolls back too
-- (nothing persists). On success it RAISEs NOTICE 'C2 ALL PASS' and removes the test user.
/*
SET search_path = public, extensions, pg_temp;
DO $$
DECLARE
  uid uuid := gen_random_uuid();
  res jsonb;
  i   int;
BEGIN
  INSERT INTO public.dev_field_ops_users (id, display_name, status) VALUES (uid, 'ZZ_verify_login_test', 'active');

  -- set a permanent PIN via the RPC (proves set_pin hashes + is readable by verify)
  PERFORM public.dev_field_ops_set_pin(uid, '1234', false, true);

  -- correct PIN -> valid, not temp
  res := public.dev_field_ops_verify_login(uid, '1234');
  IF (res->>'valid') <> 'true' OR (res->>'is_temp') <> 'false' THEN RAISE EXCEPTION 'C2 FAIL correct-pin: %', res; END IF;

  -- wrong PIN -> invalid, attempts_left 4
  res := public.dev_field_ops_verify_login(uid, '9999');
  IF (res->>'valid') <> 'false' OR (res->>'attempts_left') <> '4' THEN RAISE EXCEPTION 'C2 FAIL wrong-pin: %', res; END IF;

  -- a correct PIN resets attempts back to 5
  res := public.dev_field_ops_verify_login(uid, '1234');
  IF (res->>'attempts_left') <> '5' THEN RAISE EXCEPTION 'C2 FAIL reset-on-success: %', res; END IF;

  -- five wrong in a row -> locked
  FOR i IN 1..5 LOOP res := public.dev_field_ops_verify_login(uid, '0000'); END LOOP;
  IF (res->>'is_locked') <> 'true' THEN RAISE EXCEPTION 'C2 FAIL lockout: %', res; END IF;
  -- while locked, even the correct PIN is refused with reason=locked
  res := public.dev_field_ops_verify_login(uid, '1234');
  IF (res->>'valid') <> 'false' OR (res->>'reason') <> 'locked' THEN RAISE EXCEPTION 'C2 FAIL locked-blocks-correct: %', res; END IF;

  -- unlock, then a temp PIN logs in with is_temp=true
  PERFORM public.dev_field_ops_unlock_user(uid);
  PERFORM public.dev_field_ops_set_pin(uid, '4321', true, true);   -- temp
  res := public.dev_field_ops_verify_login(uid, '4321');
  IF (res->>'valid') <> 'true' OR (res->>'is_temp') <> 'true' THEN RAISE EXCEPTION 'C2 FAIL temp-pin: %', res; END IF;

  -- verify_login never returns a hash
  IF res::text ILIKE '%$2%' THEN RAISE EXCEPTION 'C2 FAIL hash-leak: %', res; END IF;

  DELETE FROM public.dev_field_ops_users WHERE id = uid;
  RAISE NOTICE 'C2 ALL PASS — test user removed';
END $$;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
/*
DROP FUNCTION IF EXISTS public.dev_field_ops_verify_login(uuid, text);
DROP FUNCTION IF EXISTS public.dev_field_ops_set_pin(uuid, text, boolean, boolean);
DROP FUNCTION IF EXISTS public.dev_field_ops_unlock_user(uuid);
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
