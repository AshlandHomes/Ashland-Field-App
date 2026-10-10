-- ============================================================================
-- Feature: whole-lot push carries schedule STRUCTURE (opt-in). STEP 1 of the build —
-- the undo-snapshot tables + the atomic apply function. DEV. Nothing else yet
-- (the Netlify actions, engine validation, and UI come in later steps).
--
-- Shared DB: every object here is dev_field_ops_* (OURS). It READS/UPDATES
-- dev_sched_lot_tasks and reads dev_sched_lots (also ours). ZERO LandIQ references.
--
-- WHAT THIS DOES
--   * dev_field_ops_lot_structure_snapshots       — one row per apply (who/when/source/kind)
--   * dev_field_ops_lot_structure_snapshot_tasks  — the target's structural rows BEFORE the
--       apply (immutable undo record); created WITH NO DATA from dev_sched_lot_tasks so its
--       structural columns inherit the EXACT live types (no guessing predecessors' type).
--   * dev_field_ops_apply_lot_structure(...)       — ONE transaction: guard, snapshot the
--       target's current structure, then mirror (push) or restore (undo). Atomic. Returns
--       jsonb { snapshot_id, applied } and RAISEs on any no-op or precondition failure.
--
-- TYPE-SAFE BY CONSTRUCTION: every structural write is column -> column (target<-source for
-- push, target<-snapshot for undo). No jsonb, no casts. Structural set (D-1): predecessors,
-- lag, duration, phase_name, phase_order, task_order. (est_start_date is NOT touched.)
--
-- NO GRAPH VALIDATION HERE (deliberate): cycles/dangling-pred HARD-BLOCK and the
-- dead-end/multi-source/unreachable WARNINGS are computed by the shared engine in the
-- Netlify preview/apply action BEFORE this function is called (later step). The in-function
-- guards below are the SQL-level safety net (no-ops, cross-lot, 1:1, same-template), run
-- inside the atomic boundary. Function is service_role-only.
--
-- SECURITY: RLS ON (deny-all) on both snapshot tables; service_role gets SELECT, INSERT
-- ONLY (immutable); NO anon/authenticated. Function EXECUTE locked to service_role.
-- Pre-flight RAISEs if either table OR the function name already exists (plain CREATE —
-- never CREATE OR REPLACE — so nothing is silently replaced; same collision class as the
-- LandIQ incident). (dev_schema.sql's anon-grant loop would re-grant anon on these if
-- re-run — known dev_schema tightening on the SECURITY backlog; this sets correct state.)
--
-- LIVE at promote: same objects without the dev_ prefix, same guards/RLS/grants/EXECUTE.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. Confirm dev_sched_lot_tasks has the columns the function reads/writes (incl.
--     updated_at, which the UPDATEs set). If updated_at is MISSING, tell me and I remove
--     `updated_at = now()` from both UPDATEs before you run Block B.
/*
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_sched_lot_tasks'
  AND column_name IN ('id','lot_id','bt_num','predecessors','lag','duration',
                      'phase_name','phase_order','task_order','updated_at')
ORDER BY column_name;
*/
-- A2. Confirm the function name is FREE (expect 0 rows — any row = a collision to resolve).
/*
SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'dev_field_ops_apply_lot_structure';
*/


-- ########################  BLOCK B — DEV SECTION (run once)  ################
BEGIN;

-- Pre-flight: plain CREATE only — RAISE (never adopt/replace) if either table OR the
-- function already exists.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dev_field_ops_lot_structure_snapshots',
                           'dev_field_ops_lot_structure_snapshot_tasks'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      RAISE EXCEPTION 'ABORT: table % already exists — inventory before DDL (shared DB).', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proname = 'dev_field_ops_apply_lot_structure') THEN
    RAISE EXCEPTION 'ABORT: function dev_field_ops_apply_lot_structure already exists (any signature) — drop it explicitly before re-creating.';
  END IF;
END $$;

-- 1) SNAPSHOT HEADER — one row per apply.
CREATE TABLE dev_field_ops_lot_structure_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_lot_id uuid NOT NULL,
  source_lot_id uuid,                                  -- mirrored source (NULL for undo)
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,                                  -- actor (builder name), audit only
  kind          text NOT NULL CHECK (kind IN ('push','undo'))
);
ALTER TABLE dev_field_ops_lot_structure_snapshots ENABLE ROW LEVEL SECURITY;  -- deny-all

-- 2) SNAPSHOT DETAIL — target's structural rows BEFORE apply; columns inherit the EXACT
--    types of dev_sched_lot_tasks via CREATE TABLE AS ... WITH NO DATA.
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

-- 4) ATOMIC APPLY — guard, snapshot current structure, then mirror (push) or restore (undo).
--    Plain CREATE FUNCTION (pre-flight guarantees the name is free).
CREATE FUNCTION public.dev_field_ops_apply_lot_structure(
  p_target_lot_id       uuid,
  p_source_lot_id       uuid DEFAULT NULL,   -- PUSH: mirror this source lot's structure
  p_restore_snapshot_id uuid DEFAULT NULL,   -- UNDO: restore this prior snapshot's structure
  p_actor               text DEFAULT NULL,
  p_kind                text DEFAULT 'push'  -- 'push' | 'undo'
)
RETURNS jsonb                                -- { snapshot_id, applied }
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap       uuid;
  v_applied    integer;
  v_src_n      integer;
  v_mismatch   integer;
  v_snap_tgt   uuid;
  v_snap_kind  text;
  v_detail_n   integer;
BEGIN
  IF p_target_lot_id IS NULL THEN RAISE EXCEPTION 'target lot id required'; END IF;
  IF p_kind NOT IN ('push','undo') THEN RAISE EXCEPTION 'kind must be push or undo'; END IF;

  IF p_kind = 'push' THEN
    ---------------------------------------------------------------- PUSH guards
    IF p_source_lot_id IS NULL THEN RAISE EXCEPTION 'push requires a source lot'; END IF;
    IF p_source_lot_id = p_target_lot_id THEN RAISE EXCEPTION 'source and target are the same lot'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dev_sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'target lot % not found', p_target_lot_id; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dev_sched_lots WHERE id = p_source_lot_id) THEN
      RAISE EXCEPTION 'source lot % not found', p_source_lot_id; END IF;
    -- same template (dev_sched_lots.template_id); IS DISTINCT FROM handles NULLs
    IF (SELECT template_id FROM public.dev_sched_lots WHERE id = p_source_lot_id)
         IS DISTINCT FROM
       (SELECT template_id FROM public.dev_sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'source and target are on different templates — structure copy refused';
    END IF;
    -- 1:1 by bt_num (symmetric difference must be empty) and source must have tasks
    SELECT count(*) INTO v_src_n FROM public.dev_sched_lot_tasks WHERE lot_id = p_source_lot_id;
    IF v_src_n = 0 THEN RAISE EXCEPTION 'source lot has no tasks'; END IF;
    SELECT
      (SELECT count(*) FROM (SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_source_lot_id
                             EXCEPT SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_target_lot_id) a)
    + (SELECT count(*) FROM (SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_target_lot_id
                             EXCEPT SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_source_lot_id) b)
    INTO v_mismatch;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'source/target task sets differ by % bt_num(s) — not 1:1', v_mismatch;
    END IF;
  ELSE
    ---------------------------------------------------------------- UNDO guards
    IF p_restore_snapshot_id IS NULL THEN RAISE EXCEPTION 'undo requires a snapshot to restore'; END IF;
    SELECT target_lot_id, kind INTO v_snap_tgt, v_snap_kind
      FROM public.dev_field_ops_lot_structure_snapshots WHERE id = p_restore_snapshot_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore snapshot % not found', p_restore_snapshot_id; END IF;
    IF v_snap_tgt <> p_target_lot_id THEN
      RAISE EXCEPTION 'restore snapshot belongs to a different lot (% not %)', v_snap_tgt, p_target_lot_id; END IF;
    -- only a PUSH before-snapshot is a valid restore point (undo reverts a push; it does
    -- not restore from an undo's own before-state — that would be a redo, out of scope).
    IF v_snap_kind <> 'push' THEN
      RAISE EXCEPTION 'restore snapshot is kind=% — only a push before-snapshot can be restored', v_snap_kind; END IF;
    SELECT count(*) INTO v_detail_n
      FROM public.dev_field_ops_lot_structure_snapshot_tasks WHERE snapshot_id = p_restore_snapshot_id;
    IF v_detail_n = 0 THEN RAISE EXCEPTION 'restore snapshot has no detail rows'; END IF;
  END IF;

  -- SNAPSHOT the target's CURRENT structure (before any change). Rolls back with everything
  -- if the apply fails (no orphan snapshot).
  INSERT INTO public.dev_field_ops_lot_structure_snapshots
    (id, target_lot_id, source_lot_id, created_at, created_by, kind)
  VALUES (gen_random_uuid(), p_target_lot_id, p_source_lot_id, now(), p_actor, p_kind)
  RETURNING id INTO v_snap;

  INSERT INTO public.dev_field_ops_lot_structure_snapshot_tasks
    (snapshot_id, task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order)
  SELECT v_snap, id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order
  FROM public.dev_sched_lot_tasks
  WHERE lot_id = p_target_lot_id;

  -- APPLY — column -> column (types always match). Lot-guarded.
  IF p_kind = 'push' THEN
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = src.predecessors, lag = src.lag, duration = src.duration,
           phase_name = src.phase_name, phase_order = src.phase_order, task_order = src.task_order,
           updated_at = now()
      FROM public.dev_sched_lot_tasks src
     WHERE tgt.lot_id = p_target_lot_id AND src.lot_id = p_source_lot_id AND src.bt_num = tgt.bt_num;
  ELSE
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = snp.predecessors, lag = snp.lag, duration = snp.duration,
           phase_name = snp.phase_name, phase_order = snp.phase_order, task_order = snp.task_order,
           updated_at = now()
      FROM public.dev_field_ops_lot_structure_snapshot_tasks snp
     WHERE snp.snapshot_id = p_restore_snapshot_id AND tgt.lot_id = p_target_lot_id AND tgt.id = snp.task_id;
  END IF;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  IF v_applied = 0 THEN
    RAISE EXCEPTION 'apply wrote 0 rows — nothing changed (no matching target tasks)';
  END IF;

  RETURN jsonb_build_object('snapshot_id', v_snap, 'applied', v_applied);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ########################  END DEV SECTION  #################################


-- ####################  BLOCK C — VERIFICATION. Expect 9 rows, all PASS.  ####
-- (Still 9: the new guards are RUNTIME behavior, exercised in the apply tests of later
-- steps — not schema state. These 9 are the existence/security invariants.)
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
                     WHERE grantee='service_role' AND table_schema='public' AND privilege_type IN ('SELECT','INSERT')
                       AND table_name IN ('dev_field_ops_lot_structure_snapshots','dev_field_ops_lot_structure_snapshot_tasks'))::text, '4'
  UNION ALL SELECT 'service_role_no_update_delete',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public' AND privilege_type IN ('UPDATE','DELETE')
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


-- ============================================================================
-- LIVE PROMOTE SECTION — applied & verified on live 2026-10-05 (9/9 PASS).
-- Exact mirror of the DEV block above, no dev_ prefix: snapshots into field_ops_*,
-- reads/writes sched_lots / sched_lot_tasks. Plain CREATE (pre-flight RAISEs), RLS on
-- (deny-all), service_role SELECT+INSERT only (immutable), EXECUTE service_role-only.
-- Run order on promote: this file first, THEN 2026-10-04_lot_structure_fingerprint (FK).
-- ============================================================================

-- ----  LIVE INVENTORY (read-only; run FIRST)  ----
-- A1. All three LIVE objects must be FREE (expect 0 rows).
/*
SELECT c.relname AS object
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('field_ops_lot_structure_snapshots','field_ops_lot_structure_snapshot_tasks')
UNION ALL
SELECT p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='field_ops_apply_lot_structure';
*/
-- A2. Source columns the function reads/writes (expect 10 rows; predecessors int4[]).
/*
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='sched_lot_tasks'
  AND column_name IN ('id','lot_id','bt_num','predecessors','lag','duration',
                      'phase_name','phase_order','task_order','updated_at')
ORDER BY column_name;
*/
-- A2b. sched_lots exists (expect true).
/*
SELECT (to_regclass('public.sched_lots') IS NOT NULL) AS sched_lots_exists;
*/

-- ----  LIVE BLOCK (run once, after inventory is clean)  ----
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_ops_lot_structure_snapshots',
                           'field_ops_lot_structure_snapshot_tasks'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      RAISE EXCEPTION 'ABORT: table % already exists — inventory before DDL (shared DB).', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proname = 'field_ops_apply_lot_structure') THEN
    RAISE EXCEPTION 'ABORT: function field_ops_apply_lot_structure already exists (any signature) — drop it explicitly before re-creating.';
  END IF;
END $$;

CREATE TABLE field_ops_lot_structure_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_lot_id uuid NOT NULL,
  source_lot_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  kind          text NOT NULL CHECK (kind IN ('push','undo'))
);
ALTER TABLE field_ops_lot_structure_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE field_ops_lot_structure_snapshot_tasks AS
  SELECT (NULL::uuid) AS snapshot_id,
         id AS task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order
  FROM sched_lot_tasks
  WITH NO DATA;
ALTER TABLE field_ops_lot_structure_snapshot_tasks
  ALTER COLUMN snapshot_id SET NOT NULL,
  ALTER COLUMN task_id     SET NOT NULL,
  ADD CONSTRAINT field_ops_lot_structure_snapshot_tasks_snap_fkey
      FOREIGN KEY (snapshot_id) REFERENCES field_ops_lot_structure_snapshots(id) ON DELETE CASCADE;
CREATE INDEX field_ops_lss_tasks_snap_idx
  ON field_ops_lot_structure_snapshot_tasks (snapshot_id);
ALTER TABLE field_ops_lot_structure_snapshot_tasks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON field_ops_lot_structure_snapshots      FROM anon, authenticated;
REVOKE ALL ON field_ops_lot_structure_snapshot_tasks FROM anon, authenticated;
GRANT SELECT, INSERT ON field_ops_lot_structure_snapshots      TO service_role;
GRANT SELECT, INSERT ON field_ops_lot_structure_snapshot_tasks TO service_role;

CREATE FUNCTION public.field_ops_apply_lot_structure(
  p_target_lot_id       uuid,
  p_source_lot_id       uuid DEFAULT NULL,
  p_restore_snapshot_id uuid DEFAULT NULL,
  p_actor               text DEFAULT NULL,
  p_kind                text DEFAULT 'push'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap       uuid;
  v_applied    integer;
  v_src_n      integer;
  v_mismatch   integer;
  v_snap_tgt   uuid;
  v_snap_kind  text;
  v_detail_n   integer;
BEGIN
  IF p_target_lot_id IS NULL THEN RAISE EXCEPTION 'target lot id required'; END IF;
  IF p_kind NOT IN ('push','undo') THEN RAISE EXCEPTION 'kind must be push or undo'; END IF;

  IF p_kind = 'push' THEN
    IF p_source_lot_id IS NULL THEN RAISE EXCEPTION 'push requires a source lot'; END IF;
    IF p_source_lot_id = p_target_lot_id THEN RAISE EXCEPTION 'source and target are the same lot'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'target lot % not found', p_target_lot_id; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sched_lots WHERE id = p_source_lot_id) THEN
      RAISE EXCEPTION 'source lot % not found', p_source_lot_id; END IF;
    IF (SELECT template_id FROM public.sched_lots WHERE id = p_source_lot_id)
         IS DISTINCT FROM
       (SELECT template_id FROM public.sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'source and target are on different templates — structure copy refused';
    END IF;
    SELECT count(*) INTO v_src_n FROM public.sched_lot_tasks WHERE lot_id = p_source_lot_id;
    IF v_src_n = 0 THEN RAISE EXCEPTION 'source lot has no tasks'; END IF;
    SELECT
      (SELECT count(*) FROM (SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_source_lot_id
                             EXCEPT SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_target_lot_id) a)
    + (SELECT count(*) FROM (SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_target_lot_id
                             EXCEPT SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_source_lot_id) b)
    INTO v_mismatch;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'source/target task sets differ by % bt_num(s) — not 1:1', v_mismatch;
    END IF;
  ELSE
    IF p_restore_snapshot_id IS NULL THEN RAISE EXCEPTION 'undo requires a snapshot to restore'; END IF;
    SELECT target_lot_id, kind INTO v_snap_tgt, v_snap_kind
      FROM public.field_ops_lot_structure_snapshots WHERE id = p_restore_snapshot_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore snapshot % not found', p_restore_snapshot_id; END IF;
    IF v_snap_tgt <> p_target_lot_id THEN
      RAISE EXCEPTION 'restore snapshot belongs to a different lot (% not %)', v_snap_tgt, p_target_lot_id; END IF;
    IF v_snap_kind <> 'push' THEN
      RAISE EXCEPTION 'restore snapshot is kind=% — only a push before-snapshot can be restored', v_snap_kind; END IF;
    SELECT count(*) INTO v_detail_n
      FROM public.field_ops_lot_structure_snapshot_tasks WHERE snapshot_id = p_restore_snapshot_id;
    IF v_detail_n = 0 THEN RAISE EXCEPTION 'restore snapshot has no detail rows'; END IF;
  END IF;

  INSERT INTO public.field_ops_lot_structure_snapshots
    (id, target_lot_id, source_lot_id, created_at, created_by, kind)
  VALUES (gen_random_uuid(), p_target_lot_id, p_source_lot_id, now(), p_actor, p_kind)
  RETURNING id INTO v_snap;

  INSERT INTO public.field_ops_lot_structure_snapshot_tasks
    (snapshot_id, task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order)
  SELECT v_snap, id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order
  FROM public.sched_lot_tasks
  WHERE lot_id = p_target_lot_id;

  IF p_kind = 'push' THEN
    UPDATE public.sched_lot_tasks tgt
       SET predecessors = src.predecessors, lag = src.lag, duration = src.duration,
           phase_name = src.phase_name, phase_order = src.phase_order, task_order = src.task_order,
           updated_at = now()
      FROM public.sched_lot_tasks src
     WHERE tgt.lot_id = p_target_lot_id AND src.lot_id = p_source_lot_id AND src.bt_num = tgt.bt_num;
  ELSE
    UPDATE public.sched_lot_tasks tgt
       SET predecessors = snp.predecessors, lag = snp.lag, duration = snp.duration,
           phase_name = snp.phase_name, phase_order = snp.phase_order, task_order = snp.task_order,
           updated_at = now()
      FROM public.field_ops_lot_structure_snapshot_tasks snp
     WHERE snp.snapshot_id = p_restore_snapshot_id AND tgt.lot_id = p_target_lot_id AND tgt.id = snp.task_id;
  END IF;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  IF v_applied = 0 THEN
    RAISE EXCEPTION 'apply wrote 0 rows — nothing changed (no matching target tasks)';
  END IF;

  RETURN jsonb_build_object('snapshot_id', v_snap, 'applied', v_applied);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ----  LIVE VERIFICATION (expect 9 rows, all PASS)  ----
/*
WITH checks AS (
            SELECT 'header_table_exists' AS check_name,
                   (to_regclass('public.field_ops_lot_structure_snapshots') IS NOT NULL)::text AS actual, 'true' AS expected
  UNION ALL SELECT 'detail_table_exists',
                   (to_regclass('public.field_ops_lot_structure_snapshot_tasks') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'rls_on_both',
                   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity
                     AND relname IN ('field_ops_lot_structure_snapshots','field_ops_lot_structure_snapshot_tasks'))::text, '2'
  UNION ALL SELECT 'service_role_dml_grants',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public' AND privilege_type IN ('SELECT','INSERT')
                       AND table_name IN ('field_ops_lot_structure_snapshots','field_ops_lot_structure_snapshot_tasks'))::text, '4'
  UNION ALL SELECT 'service_role_no_update_delete',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public' AND privilege_type IN ('UPDATE','DELETE')
                       AND table_name IN ('field_ops_lot_structure_snapshots','field_ops_lot_structure_snapshot_tasks'))::text, '0'
  UNION ALL SELECT 'anon_authenticated_no_grants',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee IN ('anon','authenticated') AND table_schema='public'
                       AND table_name IN ('field_ops_lot_structure_snapshots','field_ops_lot_structure_snapshot_tasks'))::text, '0'
  UNION ALL SELECT 'function_exists',
                   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                     WHERE n.nspname='public' AND p.proname='field_ops_apply_lot_structure')::text, '1'
  UNION ALL SELECT 'anon_authenticated_no_execute',
                   (has_function_privilege('anon','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE')
                 OR has_function_privilege('authenticated','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE'))::text, 'false'
  UNION ALL SELECT 'service_role_has_execute',
                   has_function_privilege('service_role','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)','EXECUTE')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/

-- ----  LIVE ROLLBACK (only for a full back-out)  ----
/*
DROP FUNCTION IF EXISTS public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text);
DROP TABLE IF EXISTS public.field_ops_lot_structure_snapshot_tasks;   -- detail first (FK)
DROP TABLE IF EXISTS public.field_ops_lot_structure_snapshots;
NOTIFY pgrst, 'reload schema';
*/


-- ============================================================================
-- AMENDMENT 2026-10-10 — est_start_date in the structure copy (Option B).
--   The structure copy now also carries est_start_date (absolute date, source->target
--   by bt_num). Per-task floors (construction-start, predecessor-earliest) are checked
--   in the Netlify handler; tasks that fail are passed in p_skip_est_bts and keep their
--   OWN est (est is NOT copied for them) — the rest of the structure copy still applies.
--   Undo fully restores est from the snapshot. Snapshot detail gains est_start_date so
--   undo can revert it; the apply function is dropped (5-arg) and re-created (6-arg,
--   adding p_skip_est_bts). No CREATE OR REPLACE. Shared DB: dev_field_ops_* / dev_sched_*
--   (OURS). ZERO LandIQ refs. ZERO sched_* schema changes (est_start_date already exists
--   on sched_lot_tasks — we only read/write its value).
-- ============================================================================


-- ----  DEV AMENDMENT INVENTORY (read-only; run FIRST)  ----
-- I1. Detail table must NOT yet have est_start_date (expect 0 rows).
/*
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_field_ops_lot_structure_snapshot_tasks'
  AND column_name='est_start_date';
*/
-- I2. The current 5-arg dev RPC must EXIST and the 6-arg must NOT (expect t, f).
/*
SELECT
  (to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)')            IS NOT NULL) AS five_arg_exists,
  (to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL) AS six_arg_exists;
*/
-- I3. est_start_date exists on the source table we read/write (expect 1 row, type date).
/*
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_sched_lot_tasks' AND column_name='est_start_date';
*/


-- ----  DEV AMENDMENT BLOCK (run once, after inventory is clean)  ----
BEGIN;

-- Pre-flight: apply EXACTLY ONCE, onto the 5-arg state (RAISE if already amended).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='dev_field_ops_lot_structure_snapshot_tasks'
                AND column_name='est_start_date') THEN
    RAISE EXCEPTION 'ABORT: est_start_date already on dev snapshot_tasks — amendment already applied.';
  END IF;
  IF to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: 5-arg dev RPC missing — run the base DEV section first.';
  END IF;
  IF to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: 6-arg dev RPC already exists — amendment already applied.';
  END IF;
END $$;

-- 1) est_start_date onto the snapshot detail (so undo can restore it). Pure ADD COLUMN
--    (DDL) — does NOT touch the INSERT-only service_role grant model.
ALTER TABLE public.dev_field_ops_lot_structure_snapshot_tasks ADD COLUMN est_start_date date;

-- 2) explicit DROP of the 5-arg function, then plain CREATE of the 6-arg version.
DROP FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text);

CREATE FUNCTION public.dev_field_ops_apply_lot_structure(
  p_target_lot_id       uuid,
  p_source_lot_id       uuid DEFAULT NULL,    -- PUSH: mirror this source lot's structure
  p_restore_snapshot_id uuid DEFAULT NULL,    -- UNDO: restore this prior snapshot's structure
  p_actor               text DEFAULT NULL,
  p_kind                text DEFAULT 'push',  -- 'push' | 'undo'
  p_skip_est_bts        integer[] DEFAULT '{}'::integer[]  -- bt_nums whose est failed the target's floors: est NOT copied (push only)
)
RETURNS jsonb                                -- { snapshot_id, applied }
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap       uuid;
  v_applied    integer;
  v_src_n      integer;
  v_mismatch   integer;
  v_snap_tgt   uuid;
  v_snap_kind  text;
  v_detail_n   integer;
BEGIN
  IF p_target_lot_id IS NULL THEN RAISE EXCEPTION 'target lot id required'; END IF;
  IF p_kind NOT IN ('push','undo') THEN RAISE EXCEPTION 'kind must be push or undo'; END IF;

  IF p_kind = 'push' THEN
    ---------------------------------------------------------------- PUSH guards
    IF p_source_lot_id IS NULL THEN RAISE EXCEPTION 'push requires a source lot'; END IF;
    IF p_source_lot_id = p_target_lot_id THEN RAISE EXCEPTION 'source and target are the same lot'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dev_sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'target lot % not found', p_target_lot_id; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dev_sched_lots WHERE id = p_source_lot_id) THEN
      RAISE EXCEPTION 'source lot % not found', p_source_lot_id; END IF;
    IF (SELECT template_id FROM public.dev_sched_lots WHERE id = p_source_lot_id)
         IS DISTINCT FROM
       (SELECT template_id FROM public.dev_sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'source and target are on different templates — structure copy refused';
    END IF;
    SELECT count(*) INTO v_src_n FROM public.dev_sched_lot_tasks WHERE lot_id = p_source_lot_id;
    IF v_src_n = 0 THEN RAISE EXCEPTION 'source lot has no tasks'; END IF;
    SELECT
      (SELECT count(*) FROM (SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_source_lot_id
                             EXCEPT SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_target_lot_id) a)
    + (SELECT count(*) FROM (SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_target_lot_id
                             EXCEPT SELECT bt_num FROM public.dev_sched_lot_tasks WHERE lot_id=p_source_lot_id) b)
    INTO v_mismatch;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'source/target task sets differ by % bt_num(s) — not 1:1', v_mismatch;
    END IF;
  ELSE
    ---------------------------------------------------------------- UNDO guards
    IF p_restore_snapshot_id IS NULL THEN RAISE EXCEPTION 'undo requires a snapshot to restore'; END IF;
    SELECT target_lot_id, kind INTO v_snap_tgt, v_snap_kind
      FROM public.dev_field_ops_lot_structure_snapshots WHERE id = p_restore_snapshot_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore snapshot % not found', p_restore_snapshot_id; END IF;
    IF v_snap_tgt <> p_target_lot_id THEN
      RAISE EXCEPTION 'restore snapshot belongs to a different lot (% not %)', v_snap_tgt, p_target_lot_id; END IF;
    IF v_snap_kind <> 'push' THEN
      RAISE EXCEPTION 'restore snapshot is kind=% — only a push before-snapshot can be restored', v_snap_kind; END IF;
    SELECT count(*) INTO v_detail_n
      FROM public.dev_field_ops_lot_structure_snapshot_tasks WHERE snapshot_id = p_restore_snapshot_id;
    IF v_detail_n = 0 THEN RAISE EXCEPTION 'restore snapshot has no detail rows'; END IF;
  END IF;

  -- SNAPSHOT the target's CURRENT structure (now incl est_start_date). Rolls back with
  -- everything if the apply fails (no orphan snapshot).
  INSERT INTO public.dev_field_ops_lot_structure_snapshots
    (id, target_lot_id, source_lot_id, created_at, created_by, kind)
  VALUES (gen_random_uuid(), p_target_lot_id, p_source_lot_id, now(), p_actor, p_kind)
  RETURNING id INTO v_snap;

  INSERT INTO public.dev_field_ops_lot_structure_snapshot_tasks
    (snapshot_id, task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order, est_start_date)
  SELECT v_snap, id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order, est_start_date
  FROM public.dev_sched_lot_tasks
  WHERE lot_id = p_target_lot_id;

  -- APPLY — column -> column (types always match). Lot-guarded.
  IF p_kind = 'push' THEN
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = src.predecessors, lag = src.lag, duration = src.duration,
           phase_name = src.phase_name, phase_order = src.phase_order, task_order = src.task_order,
           est_start_date = CASE WHEN tgt.bt_num = ANY(p_skip_est_bts)
                                 THEN tgt.est_start_date ELSE src.est_start_date END,
           updated_at = now()
      FROM public.dev_sched_lot_tasks src
     WHERE tgt.lot_id = p_target_lot_id AND src.lot_id = p_source_lot_id AND src.bt_num = tgt.bt_num;
  ELSE
    UPDATE public.dev_sched_lot_tasks tgt
       SET predecessors = snp.predecessors, lag = snp.lag, duration = snp.duration,
           phase_name = snp.phase_name, phase_order = snp.phase_order, task_order = snp.task_order,
           est_start_date = snp.est_start_date,
           updated_at = now()
      FROM public.dev_field_ops_lot_structure_snapshot_tasks snp
     WHERE snp.snapshot_id = p_restore_snapshot_id AND tgt.lot_id = p_target_lot_id AND tgt.id = snp.task_id;
  END IF;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  IF v_applied = 0 THEN
    RAISE EXCEPTION 'apply wrote 0 rows — nothing changed (no matching target tasks)';
  END IF;

  RETURN jsonb_build_object('snapshot_id', v_snap, 'applied', v_applied);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ----  DEV AMENDMENT VERIFICATION. Expect 5 rows, all PASS.  ----
/*
WITH checks AS (
            SELECT 'est_column_on_detail' AS check_name,
                   EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='dev_field_ops_lot_structure_snapshot_tasks'
                              AND column_name='est_start_date')::text AS actual, 'true' AS expected
  UNION ALL SELECT 'six_arg_function_exists',
                   (to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'five_arg_function_gone',
                   (to_regprocedure('public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)') IS NULL)::text, 'true'
  UNION ALL SELECT 'anon_authenticated_no_execute',
                   (has_function_privilege('anon','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE')
                 OR has_function_privilege('authenticated','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE'))::text, 'false'
  UNION ALL SELECT 'service_role_has_execute',
                   has_function_privilege('service_role','public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ----  DEV AMENDMENT ROLLBACK (only if needed — reverts to the 5-arg state)  ----
/*
BEGIN;
DROP FUNCTION IF EXISTS public.dev_field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[]);
-- re-create the prior 5-arg function from the base DEV SECTION above (lines ~114-223), then:
ALTER TABLE public.dev_field_ops_lot_structure_snapshot_tasks DROP COLUMN IF EXISTS est_start_date;
COMMIT;
NOTIFY pgrst, 'reload schema';
*/


-- ============================================================================
-- LIVE AMENDMENT — APPLIED & VERIFIED on live 2026-10-10 (5/5 PASS: est column on detail,
-- 6-arg exists, 5-arg gone, anon/authenticated no EXECUTE, service_role EXECUTE). Inventory
-- pre-check confirmed the 5-arg state first (I1 0 rows, I2 t/f, I3 est date). Est code
-- promote merged to main the same day (merge 75b0f34).
-- field_ops_* / sched_*, no dev_ prefix; EXACT mirror of the DEV
-- amendment above: inventory, ADD COLUMN, explicit DROP 5-arg, plain CREATE 6-arg with
-- p_skip_est_bts, EXECUTE service_role-only, NOTIFY, 5-row verification.
-- Run order on promote: AFTER the base LIVE sections (applied 2026-10-05), and BEFORE
-- the est code promote. DROP-first is required (never CREATE the 6-arg alongside the
-- 5-arg): with only one function present the deployed 5-named-arg calls resolve to the
-- 6-arg via the p_skip_est_bts default; both present would be an ambiguous overload
-- (PostgreSQL "could not choose the best candidate" -> PGRST203) and break every live
-- copy/undo for the window.
-- ============================================================================


-- ----  LIVE AMENDMENT INVENTORY (read-only; run FIRST)  ----
-- I1: detail table must NOT yet have est_start_date (expect 0 rows)
/*
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='field_ops_lot_structure_snapshot_tasks'
  AND column_name='est_start_date';
*/
-- I2: current 5-arg live RPC exists, 6-arg does NOT (expect: t , f)
/*
SELECT
  (to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)')            IS NOT NULL) AS five_arg_exists,
  (to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL) AS six_arg_exists;
*/
-- I3: est_start_date exists on the source table we read/write (expect 1 row, type date)
/*
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='sched_lot_tasks' AND column_name='est_start_date';
*/


-- ----  LIVE AMENDMENT BLOCK (run once, after inventory is clean)  ----
BEGIN;

-- Pre-flight: apply EXACTLY ONCE, onto the 5-arg state (RAISE if already amended).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='field_ops_lot_structure_snapshot_tasks'
                AND column_name='est_start_date') THEN
    RAISE EXCEPTION 'ABORT: est_start_date already on live snapshot_tasks — amendment already applied.';
  END IF;
  IF to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: 5-arg live RPC missing — promote the base LIVE section first.';
  END IF;
  IF to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: 6-arg live RPC already exists — amendment already applied.';
  END IF;
END $$;

-- 1) est_start_date onto the snapshot detail (so undo can restore it). Pure ADD COLUMN.
ALTER TABLE public.field_ops_lot_structure_snapshot_tasks ADD COLUMN est_start_date date;

-- 2) explicit DROP of the 5-arg function, then plain CREATE of the 6-arg version.
DROP FUNCTION public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text);

CREATE FUNCTION public.field_ops_apply_lot_structure(
  p_target_lot_id       uuid,
  p_source_lot_id       uuid DEFAULT NULL,    -- PUSH: mirror this source lot's structure
  p_restore_snapshot_id uuid DEFAULT NULL,    -- UNDO: restore this prior snapshot's structure
  p_actor               text DEFAULT NULL,
  p_kind                text DEFAULT 'push',  -- 'push' | 'undo'
  p_skip_est_bts        integer[] DEFAULT '{}'::integer[]  -- bt_nums whose est failed the target's floors: est NOT copied (push only)
)
RETURNS jsonb                                -- { snapshot_id, applied }
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap       uuid;
  v_applied    integer;
  v_src_n      integer;
  v_mismatch   integer;
  v_snap_tgt   uuid;
  v_snap_kind  text;
  v_detail_n   integer;
BEGIN
  IF p_target_lot_id IS NULL THEN RAISE EXCEPTION 'target lot id required'; END IF;
  IF p_kind NOT IN ('push','undo') THEN RAISE EXCEPTION 'kind must be push or undo'; END IF;

  IF p_kind = 'push' THEN
    ---------------------------------------------------------------- PUSH guards
    IF p_source_lot_id IS NULL THEN RAISE EXCEPTION 'push requires a source lot'; END IF;
    IF p_source_lot_id = p_target_lot_id THEN RAISE EXCEPTION 'source and target are the same lot'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'target lot % not found', p_target_lot_id; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sched_lots WHERE id = p_source_lot_id) THEN
      RAISE EXCEPTION 'source lot % not found', p_source_lot_id; END IF;
    IF (SELECT template_id FROM public.sched_lots WHERE id = p_source_lot_id)
         IS DISTINCT FROM
       (SELECT template_id FROM public.sched_lots WHERE id = p_target_lot_id) THEN
      RAISE EXCEPTION 'source and target are on different templates — structure copy refused';
    END IF;
    SELECT count(*) INTO v_src_n FROM public.sched_lot_tasks WHERE lot_id = p_source_lot_id;
    IF v_src_n = 0 THEN RAISE EXCEPTION 'source lot has no tasks'; END IF;
    SELECT
      (SELECT count(*) FROM (SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_source_lot_id
                             EXCEPT SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_target_lot_id) a)
    + (SELECT count(*) FROM (SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_target_lot_id
                             EXCEPT SELECT bt_num FROM public.sched_lot_tasks WHERE lot_id=p_source_lot_id) b)
    INTO v_mismatch;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'source/target task sets differ by % bt_num(s) — not 1:1', v_mismatch;
    END IF;
  ELSE
    ---------------------------------------------------------------- UNDO guards
    IF p_restore_snapshot_id IS NULL THEN RAISE EXCEPTION 'undo requires a snapshot to restore'; END IF;
    SELECT target_lot_id, kind INTO v_snap_tgt, v_snap_kind
      FROM public.field_ops_lot_structure_snapshots WHERE id = p_restore_snapshot_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore snapshot % not found', p_restore_snapshot_id; END IF;
    IF v_snap_tgt <> p_target_lot_id THEN
      RAISE EXCEPTION 'restore snapshot belongs to a different lot (% not %)', v_snap_tgt, p_target_lot_id; END IF;
    IF v_snap_kind <> 'push' THEN
      RAISE EXCEPTION 'restore snapshot is kind=% — only a push before-snapshot can be restored', v_snap_kind; END IF;
    SELECT count(*) INTO v_detail_n
      FROM public.field_ops_lot_structure_snapshot_tasks WHERE snapshot_id = p_restore_snapshot_id;
    IF v_detail_n = 0 THEN RAISE EXCEPTION 'restore snapshot has no detail rows'; END IF;
  END IF;

  -- SNAPSHOT the target's CURRENT structure (now incl est_start_date). Rolls back with
  -- everything if the apply fails (no orphan snapshot).
  INSERT INTO public.field_ops_lot_structure_snapshots
    (id, target_lot_id, source_lot_id, created_at, created_by, kind)
  VALUES (gen_random_uuid(), p_target_lot_id, p_source_lot_id, now(), p_actor, p_kind)
  RETURNING id INTO v_snap;

  INSERT INTO public.field_ops_lot_structure_snapshot_tasks
    (snapshot_id, task_id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order, est_start_date)
  SELECT v_snap, id, bt_num, predecessors, lag, duration, phase_name, phase_order, task_order, est_start_date
  FROM public.sched_lot_tasks
  WHERE lot_id = p_target_lot_id;

  -- APPLY — column -> column (types always match). Lot-guarded.
  IF p_kind = 'push' THEN
    UPDATE public.sched_lot_tasks tgt
       SET predecessors = src.predecessors, lag = src.lag, duration = src.duration,
           phase_name = src.phase_name, phase_order = src.phase_order, task_order = src.task_order,
           est_start_date = CASE WHEN tgt.bt_num = ANY(p_skip_est_bts)
                                 THEN tgt.est_start_date ELSE src.est_start_date END,
           updated_at = now()
      FROM public.sched_lot_tasks src
     WHERE tgt.lot_id = p_target_lot_id AND src.lot_id = p_source_lot_id AND src.bt_num = tgt.bt_num;
  ELSE
    UPDATE public.sched_lot_tasks tgt
       SET predecessors = snp.predecessors, lag = snp.lag, duration = snp.duration,
           phase_name = snp.phase_name, phase_order = snp.phase_order, task_order = snp.task_order,
           est_start_date = snp.est_start_date,
           updated_at = now()
      FROM public.field_ops_lot_structure_snapshot_tasks snp
     WHERE snp.snapshot_id = p_restore_snapshot_id AND tgt.lot_id = p_target_lot_id AND tgt.id = snp.task_id;
  END IF;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  IF v_applied = 0 THEN
    RAISE EXCEPTION 'apply wrote 0 rows — nothing changed (no matching target tasks)';
  END IF;

  RETURN jsonb_build_object('snapshot_id', v_snap, 'applied', v_applied);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ----  LIVE AMENDMENT VERIFICATION. Expect 5 rows, all PASS.  ----
/*
WITH checks AS (
            SELECT 'est_column_on_detail' AS check_name,
                   EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='field_ops_lot_structure_snapshot_tasks'
                              AND column_name='est_start_date')::text AS actual, 'true' AS expected
  UNION ALL SELECT 'six_arg_function_exists',
                   (to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'five_arg_function_gone',
                   (to_regprocedure('public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text)') IS NULL)::text, 'true'
  UNION ALL SELECT 'anon_authenticated_no_execute',
                   (has_function_privilege('anon','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE')
                 OR has_function_privilege('authenticated','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE'))::text, 'false'
  UNION ALL SELECT 'service_role_has_execute',
                   has_function_privilege('service_role','public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[])','EXECUTE')::text, 'true'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ----  LIVE AMENDMENT ROLLBACK (only if needed — reverts to the 5-arg state)  ----
/*
BEGIN;
DROP FUNCTION IF EXISTS public.field_ops_apply_lot_structure(uuid, uuid, uuid, text, text, integer[]);
-- re-create the prior 5-arg function from the base LIVE PROMOTE SECTION above, then:
ALTER TABLE public.field_ops_lot_structure_snapshot_tasks DROP COLUMN IF EXISTS est_start_date;
COMMIT;
NOTIFY pgrst, 'reload schema';
*/
