-- ============================================================================
-- Blocker 1 — ATOMIC "create builder" (DEV). Run ONCE (idempotent; CREATE OR REPLACE).
--
-- Replaces the old bare INSERT into dev_field_ops_builders (a builder with no user
-- and no role — locked out the moment modules are gated) with ONE Postgres function
-- that, in a SINGLE transaction, upserts the builder AND ensures its
-- dev_field_ops_users row + role. A function body is atomic: if any step raises, the
-- whole thing rolls back — so there is never a half-created builder.
--
-- Shared DB: every object here is dev_field_ops_* — zero LandIQ references.
--
-- SECURITY (D-1): Postgres grants EXECUTE on new functions to PUBLIC by default and
-- PostgREST exposes callable functions at /rest/v1/rpc/<name>. We REVOKE EXECUTE from
-- PUBLIC/anon/authenticated and GRANT only to service_role, so the function is
-- reachable ONLY with the server (service) key — never from an anon/authenticated
-- client. Verified by the query at the bottom.
--
-- D-6: this function NEVER revives a suspended identity by name-match (the same
-- name-matching flaw removed from the backfill). Adding a name whose linked user is
-- suspended is REFUSED; reactivation is an explicit, id-based admin action (blocker 2).
--
-- LIVE runs at promote: the SAME function WITHOUT the dev_ prefix
-- (field_ops_create_builder over field_ops_*), same REVOKE/GRANT, same verification.
-- ============================================================================


-- ########################  DEV FUNCTION (run once)  #########################

CREATE OR REPLACE FUNCTION public.dev_field_ops_create_builder(
  p_name         text,
  p_subdivisions text[]  DEFAULT '{}',
  p_pin_hash     text    DEFAULT NULL,
  p_temp_pin     text    DEFAULT NULL,
  p_is_admin     boolean DEFAULT false
)
RETURNS public.dev_field_ops_builders
LANGUAGE plpgsql
SECURITY INVOKER                      -- runs as the caller (service_role); no privilege escalation
SET search_path = public, pg_temp    -- deterministic resolution; not caller-controlled
AS $$
DECLARE
  v_builder  public.dev_field_ops_builders;
  v_existing public.dev_field_ops_builders;
  v_uid      uuid;
  v_role_key text := CASE WHEN COALESCE(p_is_admin, false) THEN 'admin' ELSE 'builder' END;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'builder name is required';
  END IF;

  -- D-6 GUARD — never revive a suspended identity by name. If a builder with this name
  -- exists and its linked user is suspended, refuse (reactivation is id-based, blocker 2).
  -- Inert until blocker 2 introduces suspended users; wired here so the create path is
  -- correct by construction and blocker 2 need not retrofit it.
  SELECT b.* INTO v_existing FROM public.dev_field_ops_builders b WHERE b.name = p_name;
  IF FOUND AND v_existing.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.dev_field_ops_users u
                  WHERE u.id = v_existing.user_id AND u.status = 'suspended') THEN
    RAISE EXCEPTION
      'A deactivated builder with this name exists — reactivate them or use a different name'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- 1) UPSERT the builder by name. Arbiter = the single-column UNIQUE index on name
  --    inherited from the live table (dev_schema.sql: LIKE field_ops_builders INCLUDING
  --    ALL). This is the same arbiter the old on_conflict=name upsert already relied on.
  INSERT INTO public.dev_field_ops_builders
    (name, subdivisions, pin_hash, temp_pin, is_admin, created_at, updated_at)
  VALUES
    (p_name, COALESCE(p_subdivisions, '{}'), p_pin_hash, p_temp_pin, COALESCE(p_is_admin, false), now(), now())
  ON CONFLICT (name) DO UPDATE SET
    subdivisions = EXCLUDED.subdivisions,
    pin_hash     = EXCLUDED.pin_hash,
    temp_pin     = EXCLUDED.temp_pin,
    is_admin     = EXCLUDED.is_admin,
    updated_at   = now()
  RETURNING * INTO v_builder;

  -- 2) USER — create-then-link ONLY if this builder has no user yet. Users-before-link
  --    (the FK is non-deferred), same rule as the backfill. Also self-heals any builder
  --    created by the old handler in the gap before this deploy.
  IF v_builder.user_id IS NULL THEN
    v_uid := gen_random_uuid();
    INSERT INTO public.dev_field_ops_users (id, display_name, auth_user_id, email, status)
    VALUES (v_uid, p_name, NULL, NULL, 'active');
    UPDATE public.dev_field_ops_builders SET user_id = v_uid WHERE id = v_builder.id
    RETURNING * INTO v_builder;
  ELSE
    v_uid := v_builder.user_id;
  END IF;

  -- 3) ROLE per is_admin (idempotent — safe on re-add / edit).
  INSERT INTO public.dev_field_ops_user_roles (user_id, role_id)
  SELECT v_uid, r.id FROM public.dev_field_ops_roles r WHERE r.key = v_role_key
  ON CONFLICT DO NOTHING;

  RETURN v_builder;
END;
$$;

-- SECURITY (D-1): lock the function down to the service key only.
REVOKE EXECUTE ON FUNCTION public.dev_field_ops_create_builder(text, text[], text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_create_builder(text, text[], text, text, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';   -- register the new RPC on the API immediately

-- ########################  END DEV FUNCTION  ################################


-- ####################  VERIFICATION — run after. Expect 5 rows, all PASS.  ##
/*
WITH checks AS (
            SELECT 'function_exists' AS check_name,
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname='public' AND p.proname='dev_field_ops_create_builder')::text AS actual,
                   '1' AS expected
  UNION ALL SELECT 'anon_no_execute',
                   has_function_privilege('anon',
                     'public.dev_field_ops_create_builder(text, text[], text, text, boolean)', 'EXECUTE')::text, 'false'
  UNION ALL SELECT 'authenticated_no_execute',
                   has_function_privilege('authenticated',
                     'public.dev_field_ops_create_builder(text, text[], text, text, boolean)', 'EXECUTE')::text, 'false'
  UNION ALL SELECT 'service_role_has_execute',
                   has_function_privilege('service_role',
                     'public.dev_field_ops_create_builder(text, text[], text, text, boolean)', 'EXECUTE')::text, 'true'
  UNION ALL SELECT 'name_unique_index',                     -- the ON CONFLICT (name) arbiter must exist
                   EXISTS(
                     SELECT 1 FROM pg_index i
                     JOIN pg_class c ON c.oid = i.indrelid
                     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
                     WHERE c.relname='dev_field_ops_builders' AND i.indisunique
                       AND i.indnatts = 1 AND a.attname='name')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
-- Drops the function. The old code path (bare INSERT) must be restored in supabase.js
-- at the same time (see the commit that added this file).
/*
DROP FUNCTION IF EXISTS public.dev_field_ops_create_builder(text, text[], text, text, boolean);
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
