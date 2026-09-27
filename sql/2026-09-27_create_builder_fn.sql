-- ============================================================================
-- Blocker 1 — ATOMIC "create builder" (DEV). Run ONCE (idempotent; CREATE OR REPLACE).
--
-- Replaces the old bare upsert into dev_field_ops_builders (a builder with no user
-- and no role — locked out the moment modules are gated) with ONE Postgres function
-- that, in a SINGLE transaction, upserts the builder AND ensures its
-- dev_field_ops_users row + role. A function body is atomic: if any step raises, the
-- whole thing rolls back — so there is never a half-created builder.
--
-- Shared DB: every object here is dev_field_ops_* — zero LandIQ references.
--
-- ADD-ONLY (no upsert). Add Builder REFUSES a name that already exists. Verified in
-- the repo: the only caller is submitAddBuilder, and its payload (pin_hash:null +
-- a new temp_pin) would RESET an existing builder's PIN — an accident, since PIN
-- resets belong on the independent "Set PIN" button (updateBuilderPin). Nothing else
-- relies on re-adding an existing name (Set PIN / subdivision edit / unlock / delete
-- all use other actions). So the create path is now a plain INSERT for a NEW name; an
-- existing name raises a clear error and changes nothing. No "two valid PINs" state.
--
-- NO ROLE XOR NEEDED. Because this creates a brand-new builder + brand-new user only,
-- the user has no prior role — there is never an "other" role to delete. And no app
-- path can change is_admin on an EXISTING builder (Add refuses existing names; Set PIN
-- / unlock / subdivision edit / delete never touch is_admin; there is no is_admin
-- toggle). So a single role INSERT is correct; a delete-the-other step would be dead
-- code. (Blocker 3 creates named admins with a NEW name + is_admin=true → plain INSERT,
-- admin role. Any future "change is_admin on an existing person" is a separate path.)
--
-- SECURITY (D-1): Postgres grants EXECUTE on new functions to PUBLIC by default and
-- PostgREST exposes callable functions at /rest/v1/rpc/<name>. We REVOKE EXECUTE from
-- PUBLIC/anon/authenticated and GRANT only to service_role, so the function is
-- reachable ONLY with the server (service) key. Verified by the query at the bottom.
--
-- D-6: this function NEVER revives a suspended identity by name-match. An existing name
-- whose linked user is suspended gets a specific refusal; reactivation is an explicit,
-- id-based admin action (blocker 2). (Any existing name is refused regardless.)
--
-- CATCH-UP for pre-existing unlinked builders is the backfill's job (re-run-safe), NOT
-- this function — this function only ever handles a genuinely new name.
--
-- LIVE runs at promote: the SAME function WITHOUT the dev_ prefix
-- (field_ops_create_builder over field_ops_*), same REVOKE/GRANT, same verification.
-- ============================================================================


-- ########################  DEV FUNCTION (run once)  #########################

CREATE OR REPLACE FUNCTION public.dev_field_ops_create_builder(
  p_name         text,                   -- required; must NOT already exist (add-only)
  p_subdivisions text[]  DEFAULT NULL,   -- NULL => '{}' (no subdivisions) on the new builder
  p_pin_hash     text    DEFAULT NULL,   -- NULL => no permanent PIN yet (set via Set PIN / first login)
  p_temp_pin     text    DEFAULT NULL,   -- the initial temp PIN for first login
  p_is_admin     boolean DEFAULT NULL    -- NULL => false (builder role)
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
  v_want     text;   -- role key for the new builder, from is_admin
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'builder name is required';
  END IF;

  -- ADD-ONLY GUARD — refuse any name that already exists. A suspended match gets the
  -- specific D-6 message (reactivation is an id-based admin action, blocker 2); any
  -- other existing name is refused too, pointing at the right tools. Add never edits.
  SELECT b.* INTO v_existing FROM public.dev_field_ops_builders b WHERE b.name = p_name;
  IF FOUND THEN
    IF v_existing.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.dev_field_ops_users u
                    WHERE u.id = v_existing.user_id AND u.status = 'suspended') THEN
      RAISE EXCEPTION
        'A deactivated builder named "%" exists — reactivate them or use a different name', p_name
        USING ERRCODE = 'unique_violation';
    ELSE
      RAISE EXCEPTION
        'A builder named "%" already exists — use Set PIN or edit them instead', p_name
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  -- 1) INSERT the new builder (plain INSERT — the name is proven not to exist; the
  --    UNIQUE index on name still guards against a concurrent insert). subdivisions /
  --    is_admin default to empty / false when the argument is NULL.
  INSERT INTO public.dev_field_ops_builders
    (name, subdivisions, pin_hash, temp_pin, is_admin, created_at, updated_at)
  VALUES
    (p_name, COALESCE(p_subdivisions, '{}'), p_pin_hash, p_temp_pin, COALESCE(p_is_admin, false), now(), now())
  RETURNING * INTO v_builder;

  -- 2) USER — create the user, then link (users-before-link; the FK is non-deferred).
  v_uid := gen_random_uuid();
  INSERT INTO public.dev_field_ops_users (id, display_name, auth_user_id, email, status)
  VALUES (v_uid, p_name, NULL, NULL, 'active');
  UPDATE public.dev_field_ops_builders SET user_id = v_uid WHERE id = v_builder.id
  RETURNING * INTO v_builder;

  -- 3) ROLE — one role for the new user (builder, or admin if is_admin). No "delete the
  --    other" step: a brand-new user has no prior role, and no app path changes is_admin
  --    on an existing builder, so there is nothing to reconcile.
  v_want := CASE WHEN COALESCE(v_builder.is_admin, false) THEN 'admin' ELSE 'builder' END;
  INSERT INTO public.dev_field_ops_user_roles (user_id, role_id)
  SELECT v_uid, r.id FROM public.dev_field_ops_roles r WHERE r.key = v_want;

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


-- ####################  CLEANUP — remove the ZZ_Test rows (right FK order)  ##
-- Scoped by name/id. Order: capture the user_id, delete roles, delete the builder
-- (removes the FK reference builders.user_id -> users.id), THEN delete the user — so no
-- FK is violated and no user is orphaned (the old hard Delete leaves the user behind).
-- Wrapped in a transaction for the ON COMMIT DROP temp table. Safe to run repeatedly.
/*
BEGIN;
CREATE TEMP TABLE _zz ON COMMIT DROP AS
  SELECT user_id FROM public.dev_field_ops_builders WHERE name = 'ZZ_Test' AND user_id IS NOT NULL;
DELETE FROM public.dev_field_ops_user_roles WHERE user_id IN (SELECT user_id FROM _zz);
DELETE FROM public.dev_field_ops_builders   WHERE name = 'ZZ_Test';          -- drops the FK reference first
DELETE FROM public.dev_field_ops_users      WHERE id IN (SELECT user_id FROM _zz);
COMMIT;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
-- Drops the function. The old code path (bare upsert) must be restored in supabase.js
-- at the same time (see the commit that added this file).
/*
DROP FUNCTION IF EXISTS public.dev_field_ops_create_builder(text, text[], text, text, boolean);
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
