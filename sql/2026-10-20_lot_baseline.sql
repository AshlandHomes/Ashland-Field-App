-- ============================================================================
-- Manager view S3 — FROZEN BASELINE COMPLETION DATE. Dev only.
-- ---------------------------------------------------------------------------
-- One frozen "planned completion" per lot, captured ONCE the moment construction actually
-- starts (first actual_start on any task). Before construction: nothing stored (no ahead/
-- behind for a lot that hasn't begun). After the freeze it never moves on its own — only an
-- admin reset (logged, reason required) changes it.
--
-- INSERT-ONLY HISTORY: the latest row for a lot wins; rows are NEVER updated or deleted.
--   kind: 'capture'  — the automatic freeze at first actual_start (server helper)
--         'backfill'  — one-time admin backfill for already-started lots with no row yet
--         'reset'     — admin override; `reason` REQUIRED (enforced in the handler)
-- baseline_date = the engine's planEndDate (PLANNED CPM: structure + construction_start_date,
--   ignores actuals/est) computed by a SERVER action at the freeze moment — SQL can't run the
--   engine, so every row is inserted by code, never by SQL.
--
-- SECURITY: RLS deny-all; service_role SELECT + INSERT only (immutable, like the lot-structure
-- snapshot tables); NO anon/authenticated; NO UPDATE/DELETE grant. Field-ops-owned; FK ->
-- dev_sched_lots (ours). ZERO LandIQ refs. Plain CREATE behind a RAISE pre-check (no IF NOT EXISTS).
-- LIVE at promote: same object, field_ops_ prefix, FK -> sched_lots.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. The table name must be FREE (expect 0 rows).
/*
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='dev_field_ops_lot_baseline';
*/
-- A2. FK target dev_sched_lots must EXIST (expect true).
/*
SELECT (to_regclass('public.dev_sched_lots') IS NOT NULL) AS sched_lots_exists;
*/


-- ####################  BLOCK B — DEV SECTION (run once)  ####################
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.dev_field_ops_lot_baseline') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: dev_field_ops_lot_baseline already exists — inventory before DDL (shared DB).';
  END IF;
  IF to_regclass('public.dev_sched_lots') IS NULL THEN
    RAISE EXCEPTION 'ABORT: FK target dev_sched_lots is missing.';
  END IF;
END $$;

CREATE TABLE dev_field_ops_lot_baseline (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id        uuid NOT NULL REFERENCES dev_sched_lots(id) ON DELETE CASCADE,
  baseline_date date NOT NULL,                                 -- frozen planned completion (engine planEndDate at capture)
  kind          text NOT NULL CHECK (kind IN ('backfill','capture','reset')),
  reason        text,                                          -- REQUIRED for 'reset' (handler-enforced)
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_field_ops_lot_baseline_lot_idx
  ON dev_field_ops_lot_baseline (lot_id, created_at DESC);     -- "current baseline" = latest row per lot
ALTER TABLE dev_field_ops_lot_baseline ENABLE ROW LEVEL SECURITY;  -- deny-all

REVOKE ALL ON dev_field_ops_lot_baseline FROM anon, authenticated;
GRANT SELECT, INSERT ON dev_field_ops_lot_baseline TO service_role;  -- insert-only (immutable)

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ####################  BLOCK C — VERIFICATION. Expect 5 rows, all PASS.  ####
/*
WITH checks AS (
            SELECT 'table_exists' AS check_name,
                   (to_regclass('public.dev_field_ops_lot_baseline') IS NOT NULL)::text AS actual, 'true' AS expected
  UNION ALL SELECT 'rls_on',
                   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity
                     AND relname='dev_field_ops_lot_baseline')::text, '1'
  UNION ALL SELECT 'service_role_select_insert',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND table_name='dev_field_ops_lot_baseline'
                       AND privilege_type IN ('SELECT','INSERT'))::text, '2'
  UNION ALL SELECT 'service_role_no_update_delete',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND table_name='dev_field_ops_lot_baseline'
                       AND privilege_type IN ('UPDATE','DELETE'))::text, '0'
  UNION ALL SELECT 'anon_authenticated_no_grants',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee IN ('anon','authenticated') AND table_schema='public'
                       AND table_name='dev_field_ops_lot_baseline')::text, '0'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
/*
DROP TABLE IF EXISTS public.dev_field_ops_lot_baseline;
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
