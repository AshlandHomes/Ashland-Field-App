-- ============================================================
-- ASHLAND FIELD OPS — DEV SCHEMA
-- Creates dev_* copies of all live tables in the SAME Supabase project.
-- Dev Netlify site writes here; live tables (unprefixed) are untouched.
--
-- SOURCE OF TRUTH: this file lives in the GitHub repo. Any schema change
-- must be edited here AND applied to both prefixes, so a future move to a
-- dedicated dev project is a ~1hr job, not a reverse-engineering exercise.
--
-- Safe to re-run: uses IF NOT EXISTS. Does NOT drop or alter live tables.
-- ============================================================

-- 1. STRUCTURE — clones columns, defaults, PKs, indexes from live.
--    (LIKE INCLUDING ALL does NOT copy cross-table foreign keys.)

CREATE TABLE IF NOT EXISTS dev_field_ops_builders            (LIKE field_ops_builders            INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_delays              (LIKE field_ops_delays              INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_lots                (LIKE field_ops_lots                INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_overrides           (LIKE field_ops_overrides           INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_submissions         (LIKE field_ops_submissions         INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_task_notes          (LIKE field_ops_task_notes          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_field_ops_walk_notes          (LIKE field_ops_walk_notes          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_companies               (LIKE sched_companies               INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_lot_gate_state          (LIKE sched_lot_gate_state          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_lot_task_notes          (LIKE sched_lot_task_notes          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_lot_tasks               (LIKE sched_lot_tasks               INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_lots                    (LIKE sched_lots                    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_stage_map_tasks         (LIKE sched_stage_map_tasks         INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_subdivision_lots        (LIKE sched_subdivision_lots        INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_subdivision_templates   (LIKE sched_subdivision_templates   INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_subdivisions            (LIKE sched_subdivisions            INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_template_gates          (LIKE sched_template_gates          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_template_phases         (LIKE sched_template_phases         INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_template_stage_map      (LIKE sched_template_stage_map      INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_template_tasks          (LIKE sched_template_tasks          INCLUDING ALL);
CREATE TABLE IF NOT EXISTS dev_sched_templates               (LIKE sched_templates               INCLUDING ALL);

-- 2. GRANTS — PostgREST reads/writes as anon + service_role.
--    Without these, the API returns HTTP 200 with null/empty data.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname='public' AND tablename LIKE 'dev_%'
  LOOP
    EXECUTE format('GRANT ALL ON public.%I TO anon, service_role;', t);
  END LOOP;
END $$;

-- 3. RELOAD — force PostgREST to pick up the new tables.
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
