-- ============================================================================
-- LIVE ANON LOCKDOWN — closes the anon read/write/delete exposure on the field-app
-- tables. UNPREFIXED (live) tables. The live app is UNAFFECTED: every request goes
-- through the Netlify function on the SERVICE key, which BYPASSES RLS and already holds
-- SELECT/INSERT/UPDATE/DELETE on all 23 tables (confirmed). Removing anon/authenticated
-- access is therefore invisible to the app.
--
-- SCOPE: exactly the 23 field-app tables below (field_ops_* + sched_*). NEVER a LandIQ
-- table — the list is explicit so nothing else is touched.
--
-- YOU run this on LIVE, with rollback ready. Order: STEP 0 (capture) -> STEP 1 (forward)
-- -> STEP 2 (verify) -> smoke test. If anything is wrong, run ROLLBACK.
-- ============================================================================

-- The 23 field-app tables (single source for every block below):
--   field_ops_builders, field_ops_delays, field_ops_lots, field_ops_overrides,
--   field_ops_submissions, field_ops_task_notes, field_ops_walk_notes,
--   sched_companies, sched_delay_reasons, sched_lot_gate_state, sched_lot_task_notes,
--   sched_lot_tasks, sched_lots, sched_stage_map_tasks, sched_subdivision_lots,
--   sched_subdivision_templates, sched_subdivisions, sched_task_delays,
--   sched_template_gates, sched_template_phases, sched_template_stage_map,
--   sched_template_tasks, sched_templates


-- ####################  STEP 0 — CAPTURE (run FIRST; SAVE the output)  #######
-- This GENERATES your exact, verbatim rollback from the live catalog BEFORE any change.
-- Run all three; copy the resulting text somewhere safe. It is the authoritative
-- rollback (recreates every policy + grant + RLS state exactly as it is right now).
/*
-- 0a. exact CREATE POLICY for every current policy on the 23 tables
SELECT format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
         policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
         CASE WHEN qual       IS NOT NULL THEN ' USING ('||qual||')'            ELSE '' END,
         CASE WHEN with_check  IS NOT NULL THEN ' WITH CHECK ('||with_check||')' ELSE '' END) AS rollback_sql
FROM pg_policies
WHERE schemaname='public' AND tablename = ANY(ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_companies','sched_delay_reasons','sched_lot_gate_state','sched_lot_task_notes',
  'sched_lot_tasks','sched_lots','sched_stage_map_tasks','sched_subdivision_lots',
  'sched_subdivision_templates','sched_subdivisions','sched_task_delays',
  'sched_template_gates','sched_template_phases','sched_template_stage_map',
  'sched_template_tasks','sched_templates'])
ORDER BY tablename, policyname;

-- 0b. exact GRANT for every current anon/authenticated privilege on the 23 tables
SELECT format('GRANT %s ON public.%I TO %I;', privilege_type, table_name, grantee) AS rollback_sql
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee IN ('anon','authenticated')
  AND table_name = ANY(ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_companies','sched_delay_reasons','sched_lot_gate_state','sched_lot_task_notes',
  'sched_lot_tasks','sched_lots','sched_stage_map_tasks','sched_subdivision_lots',
  'sched_subdivision_templates','sched_subdivisions','sched_task_delays',
  'sched_template_gates','sched_template_phases','sched_template_stage_map',
  'sched_template_tasks','sched_templates'])
ORDER BY table_name, grantee, privilege_type;

-- 0c. exact current RLS on/off state for the 23 tables
SELECT format('ALTER TABLE public.%I %s ROW LEVEL SECURITY;',
         relname, CASE WHEN relrowsecurity THEN 'ENABLE' ELSE 'DISABLE' END) AS rollback_sql
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relname = ANY(ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_companies','sched_delay_reasons','sched_lot_gate_state','sched_lot_task_notes',
  'sched_lot_tasks','sched_lots','sched_stage_map_tasks','sched_subdivision_lots',
  'sched_subdivision_templates','sched_subdivisions','sched_task_delays',
  'sched_template_gates','sched_template_phases','sched_template_stage_map',
  'sched_template_tasks','sched_templates'])
ORDER BY relname;
*/


-- ####################  STEP 1 — FORWARD (run after STEP 0)  #################
-- Data-driven and idempotent: for each of the 23 tables — drop EVERY policy, revoke ALL
-- from anon + authenticated, enable RLS (deny-all). One pass covers the permissive
-- policies, the anon grants, AND the 3 RLS-off tables. Scoped to the explicit list only.
DO $$
DECLARE
  t   text;
  pol text;
  tbls text[] := ARRAY[
    'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
    'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
    'sched_companies','sched_delay_reasons','sched_lot_gate_state','sched_lot_task_notes',
    'sched_lot_tasks','sched_lots','sched_stage_map_tasks','sched_subdivision_lots',
    'sched_subdivision_templates','sched_subdivisions','sched_task_delays',
    'sched_template_gates','sched_template_phases','sched_template_stage_map',
    'sched_template_tasks','sched_templates'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE NOTICE 'skip (missing): %', t;
      CONTINUE;
    END IF;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';


-- ####################  STEP 2 — VERIFY. Expect EXACTLY 4 rows, all PASS.  ###
/*
WITH t AS (SELECT unnest(ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_companies','sched_delay_reasons','sched_lot_gate_state','sched_lot_task_notes',
  'sched_lot_tasks','sched_lots','sched_stage_map_tasks','sched_subdivision_lots',
  'sched_subdivision_templates','sched_subdivisions','sched_task_delays',
  'sched_template_gates','sched_template_phases','sched_template_stage_map',
  'sched_template_tasks','sched_templates']) AS name),
checks AS (
            SELECT 'policies_remaining' AS check_name,
                   (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN (SELECT name FROM t))::text AS actual, '0' AS expected
  UNION ALL SELECT 'anon_privs_remaining',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE table_schema='public' AND grantee='anon' AND table_name IN (SELECT name FROM t))::text, '0'
  UNION ALL SELECT 'authenticated_privs_remaining',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE table_schema='public' AND grantee='authenticated' AND table_name IN (SELECT name FROM t))::text, '0'
  UNION ALL SELECT 'rls_disabled_count',
                   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace
                     AND relname IN (SELECT name FROM t) AND NOT relrowsecurity)::text, '0'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK  ############################################
-- PRIMARY rollback = the saved output of STEP 0 (verbatim, catalog-exact). Paste it back.
--
-- FALLBACK rollback (hand-written from the assessed pre-state, in case STEP 0 wasn't
-- saved). Recreates the permissive policies and re-grants anon EXACTLY as observed.
-- NOTE: STEP 0's output is authoritative if the live state differs from this.
/*
-- secret_all (PERMISSIVE, ALL, to public, USING true / WITH CHECK true) on every table
-- that had it:
DO $$
DECLARE t text; tbls text[] := ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_lot_gate_state','sched_lot_task_notes','sched_lot_tasks','sched_lots',
  'sched_stage_map_tasks','sched_template_gates','sched_template_phases',
  'sched_template_stage_map','sched_template_tasks','sched_templates'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('CREATE POLICY secret_all ON public.%I AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- the two extra allow_all_* policies:
CREATE POLICY allow_all_delays     ON public.field_ops_delays     AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY allow_all_task_notes ON public.field_ops_task_notes AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);

-- re-grant anon on the 12 tables that had anon grants (full DML):
DO $$
DECLARE t text; tbls text[] := ARRAY[
  'field_ops_builders','field_ops_delays','field_ops_lots','field_ops_overrides',
  'field_ops_submissions','field_ops_task_notes','field_ops_walk_notes',
  'sched_delay_reasons','sched_lot_task_notes','sched_lot_tasks','sched_task_delays','sched_template_tasks'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
  END LOOP;
END $$;

-- restore RLS OFF on the 3 tables that were RLS-off before lockdown:
ALTER TABLE public.sched_subdivision_lots      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sched_subdivision_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sched_subdivisions          DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
