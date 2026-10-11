-- ============================================================================
-- SECURITY FIX — self-service set-PIN must PROVE the temp PIN, atomically. Dev only.
-- ---------------------------------------------------------------------------
-- The hole: setBuilderPin set a new permanent PIN from { name, new PIN } with NO proof of
-- the person's current temp PIN. Since the API secret ships to every client, anyone could
-- set any person's PIN by name, log in as them, and (post-S2) become a manager.
--
-- This RPC makes the temp-PIN proof part of the SAME atomic DB call that sets the new PIN:
--   dev_field_ops_claim_temp_pin(p_user_id, p_temp_pin, p_new_pin) -> jsonb { ok, reason, attempts_left }
--   * only works when a temp_pin_hash EXISTS and the supplied temp PIN matches it (bcrypt);
--   * a WRONG temp PIN counts toward the 5-try lockout (same policy as login);
--   * rejects a new PIN equal to the temp PIN (reason 'same_as_temp');
--   * on success: set pin_hash = bcrypt(new), CLEAR temp_pin_hash, reset attempts + lock.
-- No hash ever leaves the DB. dev_field_ops_set_pin stays for ADMIN-verified use only.
--
-- Discipline: plain CREATE FUNCTION behind a RAISE pre-check (no CREATE OR REPLACE);
-- SECURITY DEFINER; search_path pinned; EXECUTE service_role only. Field-ops-owned; ZERO
-- LandIQ tables. Depends on S1a columns + pgcrypto (extensions).
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. The function name must be free (expect 0 rows).
/*
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='dev_field_ops_claim_temp_pin';
*/


-- ####################  BLOCK B — FUNCTION (run once)  #######################
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='dev_field_ops_claim_temp_pin') THEN
    RAISE EXCEPTION 'ABORT: dev_field_ops_claim_temp_pin already exists — drop it explicitly before re-creating.';
  END IF;
  IF to_regprocedure('extensions.crypt(text, text)') IS NULL AND to_regprocedure('public.crypt(text, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: pgcrypto crypt() not found.';
  END IF;
END $$;

CREATE FUNCTION public.dev_field_ops_claim_temp_pin(p_user_id uuid, p_temp_pin text, p_new_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_temp     text;
  v_attempts integer;
  v_locked   boolean;
BEGIN
  IF p_new_pin IS NULL OR p_new_pin !~ '^\d{4}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_new_pin');
  END IF;
  SELECT temp_pin_hash, failed_attempts, is_locked
    INTO v_temp, v_attempts, v_locked
    FROM public.dev_field_ops_users WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found'); END IF;
  IF v_locked THEN RETURN jsonb_build_object('ok', false, 'reason', 'locked'); END IF;
  IF v_temp IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_temp'); END IF;        -- no self-service set without a pending temp
  IF p_new_pin = p_temp_pin THEN RETURN jsonb_build_object('ok', false, 'reason', 'same_as_temp'); END IF;

  IF crypt(p_temp_pin, v_temp) <> v_temp THEN                                                        -- WRONG temp PIN -> counts an attempt
    v_attempts := COALESCE(v_attempts,0) + 1;
    UPDATE public.dev_field_ops_users
       SET failed_attempts = v_attempts, is_locked = (v_attempts >= 5), updated_at = now()
     WHERE id = p_user_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_temp', 'attempts_left', GREATEST(0, 5 - v_attempts));
  END IF;

  UPDATE public.dev_field_ops_users
     SET pin_hash = crypt(p_new_pin, gen_salt('bf')), temp_pin_hash = NULL,
         failed_attempts = 0, is_locked = false, updated_at = now()
   WHERE id = p_user_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dev_field_ops_claim_temp_pin(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_claim_temp_pin(uuid, text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ####################  BLOCK C1 — SECURITY VERIFICATION. Expect 4, all PASS.  ####
/*
WITH checks AS (
            SELECT 'exists' AS check_name,
                   (to_regprocedure('public.dev_field_ops_claim_temp_pin(uuid, text, text)') IS NOT NULL)::text AS actual, 'true' AS expected
  UNION ALL SELECT 'security_definer',
                   (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='dev_field_ops_claim_temp_pin')::text, 'true'
  UNION ALL SELECT 'search_path_pinned',
                   (SELECT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')
                     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='dev_field_ops_claim_temp_pin')::text, 'true'
  UNION ALL SELECT 'execute_service_role_only',
                   (has_function_privilege('service_role','public.dev_field_ops_claim_temp_pin(uuid, text, text)','EXECUTE')
                AND NOT has_function_privilege('anon','public.dev_field_ops_claim_temp_pin(uuid, text, text)','EXECUTE')
                AND NOT has_function_privilege('authenticated','public.dev_field_ops_claim_temp_pin(uuid, text, text)','EXECUTE'))::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  BLOCK C2 — FUNCTIONAL TEST (atomic; self-cleaning)  ##
-- Throwaway user with a TEMP pin: wrong temp refused (+attempt), same-as-temp refused,
-- correct temp sets the permanent PIN and clears temp. Then DELETE. Any assert rolls it all back.
/*
SET search_path = public, extensions, pg_temp;
DO $$
DECLARE uid uuid := gen_random_uuid(); res jsonb; v_perm text; v_temp text;
BEGIN
  INSERT INTO public.dev_field_ops_users (id, display_name, status) VALUES (uid, 'ZZ_claim_temp_test', 'active');
  PERFORM public.dev_field_ops_set_pin(uid, '2468', true, true);   -- seed a TEMP pin

  res := public.dev_field_ops_claim_temp_pin(uid, '0000', '1357');            -- wrong temp
  IF (res->>'ok') <> 'false' OR (res->>'reason') <> 'wrong_temp' OR (res->>'attempts_left') <> '4' THEN RAISE EXCEPTION 'FAIL wrong_temp: %', res; END IF;

  res := public.dev_field_ops_claim_temp_pin(uid, '2468', '2468');            -- new == temp
  IF (res->>'ok') <> 'false' OR (res->>'reason') <> 'same_as_temp' THEN RAISE EXCEPTION 'FAIL same_as_temp: %', res; END IF;

  res := public.dev_field_ops_claim_temp_pin(uid, '2468', '1357');            -- correct temp -> set permanent
  IF (res->>'ok') <> 'true' THEN RAISE EXCEPTION 'FAIL claim: %', res; END IF;

  SELECT pin_hash, temp_pin_hash INTO v_perm, v_temp FROM public.dev_field_ops_users WHERE id = uid;
  IF v_perm IS NULL OR v_temp IS NOT NULL THEN RAISE EXCEPTION 'FAIL post-state (perm set / temp cleared): perm=% temp=%', v_perm, v_temp; END IF;
  IF crypt('1357', v_perm) <> v_perm THEN RAISE EXCEPTION 'FAIL new pin does not verify'; END IF;

  -- a second claim now fails: temp already consumed
  res := public.dev_field_ops_claim_temp_pin(uid, '2468', '2000');
  IF (res->>'ok') <> 'false' OR (res->>'reason') <> 'no_temp' THEN RAISE EXCEPTION 'FAIL no_temp-after-claim: %', res; END IF;

  DELETE FROM public.dev_field_ops_users WHERE id = uid;
  RAISE NOTICE 'claim_temp_pin ALL PASS — test user removed';
END $$;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
/*
DROP FUNCTION IF EXISTS public.dev_field_ops_claim_temp_pin(uuid, text, text);
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
