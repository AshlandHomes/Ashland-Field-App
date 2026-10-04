-- ============================================================================
-- Feature: lot-structure push — UNDO lock-in (5d). An "after-copy" structure
-- fingerprint, stored INSERT-ONLY, so Undo is offered ONLY while the lot's current
-- schedule structure still equals what the copy produced. ANY structure edit
-- (duration, predecessor, lag, phase, task order — through any path) makes the
-- current structure differ, so Undo vanishes immediately. Statuses/dates/notes
-- never change the fingerprint (undo never touches them). DEV.
--
-- WHY A COMPANION TABLE (not a column on the snapshot header):
--   dev_field_ops_lot_structure_snapshots is IMMUTABLE by design — service_role has
--   SELECT + INSERT only, ZERO UPDATE/DELETE. We must NOT add a PATCH-after-insert
--   column to it (that would need an UPDATE grant and break the immutability guarantee).
--   Instead this new INSERT-ONLY companion holds the fingerprint, inserted by the
--   applyLotStructurePush Netlify handler right AFTER the RPC returns the snapshot id.
--   No RPC change. No UPDATE grant anywhere.
--
-- WHAT THIS DOES
--   * dev_field_ops_lot_structure_fingerprints — one row per PUSH snapshot:
--       { id, snapshot_id FK -> …snapshots(id) ON DELETE CASCADE, after_fingerprint text,
--         created_at }. UNIQUE(snapshot_id) — one fingerprint per snapshot, insert-only.
--
-- Shared DB: dev_field_ops_* (OURS). FK references dev_field_ops_lot_structure_snapshots
-- (also ours). ZERO LandIQ references. ZERO sched_* changes.
--
-- SECURITY: RLS ON (deny-all); service_role SELECT + INSERT ONLY (immutable); NO
-- anon/authenticated. Plain CREATE — pre-flight RAISEs if the table already exists.
--
-- LIVE at promote: same object without the dev_ prefix (see the LIVE section at the end),
-- FK -> field_ops_lot_structure_snapshots, same RLS/grants.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. The new table name must be FREE (expect 0 rows — any row = a collision to resolve).
/*
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relname='dev_field_ops_lot_structure_fingerprints';
*/
-- A2. The FK target (snapshot header) must EXIST (expect 1 row).
/*
SELECT (to_regclass('public.dev_field_ops_lot_structure_snapshots') IS NOT NULL) AS snapshots_exists;
*/


-- ########################  BLOCK B — DEV SECTION (run once)  ################
BEGIN;

-- Pre-flight: plain CREATE only — RAISE (never adopt/replace) if the table already exists.
DO $$
BEGIN
  IF to_regclass('public.dev_field_ops_lot_structure_fingerprints') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: table dev_field_ops_lot_structure_fingerprints already exists — inventory before DDL (shared DB).';
  END IF;
  IF to_regclass('public.dev_field_ops_lot_structure_snapshots') IS NULL THEN
    RAISE EXCEPTION 'ABORT: FK target dev_field_ops_lot_structure_snapshots is missing — run the lot_structure_push migration first.';
  END IF;
END $$;

CREATE TABLE dev_field_ops_lot_structure_fingerprints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id       uuid NOT NULL UNIQUE
                      REFERENCES dev_field_ops_lot_structure_snapshots(id) ON DELETE CASCADE,
  after_fingerprint text NOT NULL,                     -- canonical JSON of the target's STRUCT_COLS right after the copy
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_field_ops_lsf_snap_idx
  ON dev_field_ops_lot_structure_fingerprints (snapshot_id);
ALTER TABLE dev_field_ops_lot_structure_fingerprints ENABLE ROW LEVEL SECURITY;  -- deny-all

-- GRANTS — service_role only; SELECT + INSERT (immutable: no UPDATE/DELETE). No anon/auth.
REVOKE ALL ON dev_field_ops_lot_structure_fingerprints FROM anon, authenticated;
GRANT SELECT, INSERT ON dev_field_ops_lot_structure_fingerprints TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ####################  BLOCK C — VERIFICATION. Expect 5 rows, all PASS.  ####
/*
WITH checks AS (
            SELECT 'table_exists' AS check_name,
                   (to_regclass('public.dev_field_ops_lot_structure_fingerprints') IS NOT NULL)::text AS actual, 'true' AS expected
  UNION ALL SELECT 'rls_on',
                   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity
                     AND relname='dev_field_ops_lot_structure_fingerprints')::text, '1'
  UNION ALL SELECT 'service_role_select_insert',   -- SELECT + INSERT = 2
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND table_name='dev_field_ops_lot_structure_fingerprints'
                       AND privilege_type IN ('SELECT','INSERT'))::text, '2'
  UNION ALL SELECT 'service_role_no_update_delete',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee='service_role' AND table_schema='public'
                       AND table_name='dev_field_ops_lot_structure_fingerprints'
                       AND privilege_type IN ('UPDATE','DELETE'))::text, '0'
  UNION ALL SELECT 'anon_authenticated_no_grants',
                   (SELECT count(*) FROM information_schema.role_table_grants
                     WHERE grantee IN ('anon','authenticated') AND table_schema='public'
                       AND table_name='dev_field_ops_lot_structure_fingerprints')::text, '0'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
/*
DROP TABLE IF EXISTS public.dev_field_ops_lot_structure_fingerprints;
NOTIFY pgrst, 'reload schema';
*/


-- ============================================================================
-- LIVE SECTION (run ONLY at promotion — same object, no dev_ prefix). Mirrors the
-- DEV block exactly: pre-flight, CREATE, UNIQUE(snapshot_id), FK ON DELETE CASCADE,
-- index, RLS ON, service_role SELECT+INSERT only, no anon/authenticated, NOTIFY.
-- ============================================================================
/*
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.field_ops_lot_structure_fingerprints') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: table field_ops_lot_structure_fingerprints already exists — inventory before DDL (shared DB).';
  END IF;
  IF to_regclass('public.field_ops_lot_structure_snapshots') IS NULL THEN
    RAISE EXCEPTION 'ABORT: FK target field_ops_lot_structure_snapshots is missing — promote the lot_structure_push migration first.';
  END IF;
END $$;
CREATE TABLE field_ops_lot_structure_fingerprints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id       uuid NOT NULL UNIQUE
                      REFERENCES field_ops_lot_structure_snapshots(id) ON DELETE CASCADE,
  after_fingerprint text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_ops_lsf_snap_idx ON field_ops_lot_structure_fingerprints (snapshot_id);
ALTER TABLE field_ops_lot_structure_fingerprints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON field_ops_lot_structure_fingerprints FROM anon, authenticated;
GRANT SELECT, INSERT ON field_ops_lot_structure_fingerprints TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
*/
