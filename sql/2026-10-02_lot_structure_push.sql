-- ============================================================================
-- Feature: whole-lot push carries schedule STRUCTURE (opt-in). STEP 1 of the build —
-- the undo-snapshot tables + the atomic apply function. DEV. Nothing else yet
-- (the Netlify actions, engine validation, and UI come in later steps).
--
-- Shared DB: every object here is dev_field_ops_* (OURS). It READS/UPDATES
-- dev_sched_lot_tasks (also ours). ZERO LandIQ references.
--
-- WHAT THIS DOES
--   * dev_field_ops_lot_structure_snapshots       — one row per apply (who/when/source/kind)
--   * dev_field_ops_lot_structure_snapshot_tasks  — the target's structural rows BEFORE the
--       apply (immutable undo record); created WITH NO DATA from dev_sched_lot_tasks so its
--       structural columns inherit the EXACT live types (no guessing predecessors' type).
--   * dev_field_ops_apply_lot_structure(...)       — ONE transaction: snapshot the target's
--       current structure, then mirror (push) or restore (undo). Atomic = all-or-nothing.
--
-- TYPE-SAFE BY CONSTRUCTION: every structural write is column -> column (target<-source for
-- push, target<-snapshot for undo). No jsonb, no casts, so predecessors/lag/duration copy
-- whatever their real types are. Structural set (D-1): predecessors, lag, duration,
-- phase_name, phase_order, task_order. (est_start_date is NOT touched — lot-specific.)
--
-- NO GRAPH VALIDATION HERE (deliberate): cycles/dangling-pred HARD-BLOCK and the
-- dead-end/multi-source/unreachable WARNINGS are computed by the shared engine in the
-- Netlify preview/apply action BEFORE this function is ever called (later step). This
-- function trusts a pre-validated request; it is service_role-only (same effective
-- exposure as every other write — on the SECURITY backlog, not worse).
--
-- SECURITY: RLS ON (deny-all) on both snapshot tables; service_role gets SELECT, INSERT
-- ONLY (immutable — no UPDATE/DELETE); NO anon/authenticated. Function EXECUTE locked to
-- service_role. (Note: dev_schema.sql's anon-grant loop would re-grant anon on these if
-- re-run — that's the known dev_schema tightening on the SECURITY backlog; this migration
-- sets the correct state and explicitly revokes anon/authenticated.)
--
-- LIVE at promote: same objects without the dev_ prefix (field_ops_* over sched_*), same
-- RLS/grants/EXECUTE. Written out in full at promote.
-- ============================================================================


-- ####################  INVENTORY (read-only; run FIRST)  ####################
-- Confirms the 7 structural columns exist on the live-cloned dev_sched_lot_tasks (so the
-- CREATE TABLE AS inherits them) and shows their exact types. Informational.
/*
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_sched_lot_tasks'
  AND column_name IN ('predecessors','lag','duration','phase_name','phase_order','task_order','bt_num','id','lot_id')
ORDER BY column_name;
*/


-- ########################  DEV SECTION (run once)  ##########################
BEGIN;

-- Pre-flight: plain CREATE only — RAISE (never adopt) if either table already exists.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dev_field_ops_lot_structure_snapshots',
                           'dev_field_ops_lot_structure_snapshot_tasks'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      RAISE EXCEPTION 'ABORT: table % already exists — inventory before DDL (shared DB).', t;
    END IF;
  END LOOP;
END $$;

-- 1) SNAPSHOT HEADER — one row per apply.
CREATE TABLE dev_field_ops_lot_structure_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_lot_id uuid NOT NULL,
  source_lot_id uuid,                                  -- the mirrored source (NULL for undo)
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,                                  -- actor (builder name), audit only
  kind          text NOT NULL CHECK (kind IN ('push','undo'))
);
ALTER TABLE dev_field_ops_lot_structure_snapshots ENABLE ROW LEVEL SECURITY;  -- deny-all

-- 2) SNAPSHOT DETAIL — the target's structural rows BEFORE the apply. Columns inherit the
--    EXACT types of dev_sched_lot_tasks (predecessors etc.) via CREATE TABLE AS ... NO DATA.
CREATE TABLE dev_field_ops_lot_structure_snapshot_tasks AS
  SELECT (NULL::uuid) AS snapshot_id,
         id AS task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order
  FROM dev_sched_lot_tasks
  WITH NO DATA;
ALTER TABLE dev_field_ops_lot_structure_snapshot_tasks
  ALTER COLUMN snapshot_id SET NOT NULL,
  ALTER COLUMN task_id     SET NOT NULL,
  ADD CONSTRAINT dev_field_ops_lot_structure_snapshot_tasks_snap_fkey
      FOREIGN KEY (snapshot_id) REFERENCES dev_field_ops_lot_structure_snapshots(id) ON DELETE CASCADE;
CREATE INDEX dev_field_ops_lss_tasks_snap_idx
  ON dev_field_ops_lot_structure_snapshot_tasks (snapshot_id);
ALTER TABLE dev_field_ops_lot_structure_snapshot_tasks ENABLE ROW LEVEL SECURITY;  -- deny-all

-- 3) GRANTS — service_role only; SELECT + INSERT (immutable: no UPDATE/DELETE). No anon/auth.
REVOKE ALL ON dev_field_ops_lot_structure_snapshots      FROM anon, authenticated;
REVOKE ALL ON dev_field_ops_lot_structure_snapshot_tasks FROM anon, authenticated;
GRANT SELECT, INSERT ON dev_field_ops_lot_structure_snapshots      TO service_role;
GRANT SELECT, INSERT ON dev_field_ops_lot_structure_snapshot_tasks TO service_role;

-- 4) ATOMIC APPLY — snapshot current structure, then mirror (push) or restore (undo).
CREATE OR REPLACE FUNCTION public.dev_field_ops_apply_lot_structure(
  p_target_lot_id       uuid,
  p_source_lot_id       uuid DEFAULT NULL,   -- PUSH: mirror this source lot's structure
  p_restore_snapshot_id uuid DEFAULT NULL,   -- UNDO: restore this prior snapshot's structure
  p_actor               text DEFAULT NULL,
  p_kind                text DEFAULT 'push'  -- 'push' | 'undo'
)
RETURNS uuid                                 -- the NEW snapshot id (this apply's before-state)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap uuid;
BEGIN
  IF p_target_lot_id IS NULL THEN RAISE EXCEPTION 'target lot id required'; END IF;
  IF p_kind NOT IN ('push','undo') THEN RAISE EXCEPTION 'kind must be push or undo'; END IF;
  IF p_kind = 'push' AND p_source_lot_id IS NULL THEN
    RAISE EXCEPTION 'push requires a source lot'; END IF;
  IF p_kind = 'undo' AND p_restore_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'undo requires a snapshot to restore'; END IF;

  -- 1) SNAPSHOT the target's CURRENT structure (before any change). Immutable record;
  --    rolls back with everything else if the apply below fails (no orphan snapshot).
  INSERT INTO public.dev_field_ops_lot_structure_snapshots
    (id, target_lot_id, source_lot_id, created_at, created_by, kind)
  VALUES (gen_random_uuid(), p_target_lot_id, p_source_lot_id, now(), p_actor, p_kind)
  RETURNING id INTO v_snap;

  INSERT INTO public.dev_field_ops_lot_structure_snapshot_tasks
    (snapshot_id, task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order)
  SELECT v_snap, id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order
  FROM public.dev_sched_lot_tasks
  WHERE lot_id = p_target_lot_id;

  -- 2) APPLY — column -> column (types always match; no casts). Lot-guarded both sides.
  IF p_kind = 'push' THEN
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = src.predecessors,
           lag          = src.lag,
           duration     = src.duration,
           phase_name   = src.phase_name,
           phase_order  = src.phase_order,
           task_order   = src.task_order,
           updated_at   = now()
      FROM public.dev_sched_lot_tasks src
     WHERE tgt.lot_id = p_target_lot_id
       AND src.lot_id = p_source_lot_id
       AND src.bt_num = tgt.bt_num;
  ELSE  -- undo: restore the target's structure from the chosen snapshot's detail rows
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = snp.predecessors,
           lag          = snp.lag,
           duration     = snp.duration,
           phase_name   = snp.phase_name,
           phase_order  = snp.phase_order,
           task_order   = snp.task_order,
           updated_at   = now()
      FROM public.dev_field_ops_lot_structure_snapshot_tasks snp
     WHERE snp.snapshot_id = p_restore_snapshot_id
       AND tgt.lot_id = p_target_lot_id
       AND tgt.id     = snp.task_id;
  END IF;

  RETURN v_snap;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ########################  END DEV SECTION  #################################


-- ####################  VERIFICATION — run after. Expect 9 rows, all PASS.  ##
/*
WITH checks AS (
            SELECT 'header_table_exists' AS check_name,
                   (to_regclass('public.dev_field_ops_lot_structure_snapshots') IS NOT NULL)::text AS actual, 'true' AS expected
  UNION ALL SELECT 'detail_table_exists',
                   (to_regclass('public.dev_field_ops_lot_structure_snapshot_tasks') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'rls_on_both',
                   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity
                     AND relname IN ('dev_field_ops_lot_structure_snapshots','dev_field_ops_lot_structure_snapshot_tasks'))::text, '2'
  UNION ALL SELECT 'service_role_dml_grants',   -- SELECT+INSERT on each of the 2 tables = 4
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND privilege_type IN ('SELECT','INSERT')
                       AND table_name IN ('dev_field_ops_lot_structure_snapshots','dev_field_ops_lot_structure_snapshot_tasks'))::text, '4'
  UNION ALL SELECT 'service_role_no_update_delete',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND privilege_type IN ('UPDATE','DELETE')
                       AND table_name IN ('dev_field_ops_lot_structure_snapshots','dev_field_ops_lot_structure_snapshot_tasks'))::text, '0'
  UNION ALL SELECT 'anon_authenticated_no_grants',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee IN ('anon','authenticated') AND table_schema='public'
                       AND table_name IN ('dev_field_ops_lot_structure_snapshots','dev_field_ops_lot_structure_snapshot_tasks'))::text, '0'
  UNION ALL SELECT 'function_exists',
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='dev_field_ops_apply_lot_structure')::text, '1'
  UNION ALL SELECT 'anon_authenticated_no_execute',
                   (has_function_privilege('anon','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE')
                 OR has_function_privilege('authenticated','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE'))::text, 'false'
  UNION ALL SELECT 'service_role_has_execute',
                   has_function_privilege('service_role','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
/*
DROP FUNCTION IF EXISTS public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text);
DROP TABLE IF EXISTS public.dev_field_ops_lot_structure_snapshot_tasks;   -- detail first (FK)
DROP TABLE IF EXISTS public.dev_field_ops_lot_structure_snapshots;
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
