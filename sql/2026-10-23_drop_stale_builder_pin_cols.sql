-- ============================================================================
-- Manager-view cleanup — DROP the stale builder PIN columns. Dev only.
-- ---------------------------------------------------------------------------
-- WHY. S1a (2026-10-10_users_pin_login.sql) copied every builder PIN onto its
-- LINKED dev_field_ops_users row, HASHED, and S1b flipped every read/write to the
-- person: the field app now verifies via rpc/field_ops_verify_login, sets via
-- rpc/field_ops_set_pin, proves temp PINs via rpc/field_ops_claim_temp_pin, and
-- reads credential PRESENCE from dev_field_ops_users (pin_hash / temp_pin_hash).
-- The four columns on dev_field_ops_builders are now READ BY NOTHING and WRITTEN
-- BY NOTHING — the only code that still names them does so to SCRUB them out of
-- API output (supabase.js: `const { pin_hash, temp_pin, ...safe } = b`). They hold
-- CLEARTEXT PINs and lock state that can only drift from the real source. Two
-- sources for one fact is exactly the thing we are collapsing: delete the copy.
--
--   dev_field_ops_builders.pin_hash        (misnamed; CLEARTEXT) -> gone
--   dev_field_ops_builders.temp_pin        (misnamed; CLEARTEXT) -> gone
--   dev_field_ops_builders.failed_attempts (lock counter)        -> gone
--   dev_field_ops_builders.is_locked       (lock flag)           -> gone
--
-- The live source for all four is dev_field_ops_users (hashed pin_hash /
-- temp_pin_hash + failed_attempts + is_locked, enforced in the RPCs). Nothing here
-- touches that table.
--
-- SAFETY. Field-ops-owned table only. ZERO LandIQ tables. No grants/RLS change.
-- CLEAR first (NULL/zero/false) so the drop can't silently mask a live writer, then
-- DROP. One transaction, all-or-nothing, behind a DO-block that RAISEs if ANY of the
-- columns is already gone (migration already applied) OR if the hashed credential on
-- dev_field_ops_users is MISSING for a builder that still carries a cleartext PIN
-- here (would mean S1a never finished for that row — STOP, do not drop the only copy).
--
-- ROLLBACK is a RE-ADD of empty columns only — the cleartext values are NOT
-- recoverable, which is intended (they are stale and duplicative; the real,
-- hashed credential lives on dev_field_ops_users and is untouched).
--
-- LIVE EQUIVALENT (at DB separation): same script against field_ops_builders
-- (unprefixed) AFTER confirming live S1a/S1b shipped and live reads come from
-- field_ops_users. Run the Block-A inventory on live FIRST; if any live builder
-- still has a cleartext PIN with no matching hash on field_ops_users, the pre-check
-- RAISE will (correctly) abort — migrate that row before dropping on live.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########
-- A1. The 4 columns must still EXIST on dev_field_ops_builders (expect 4 rows).
/*
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_field_ops_builders'
  AND column_name IN ('pin_hash','temp_pin','failed_attempts','is_locked')
ORDER BY column_name;
*/

-- A2. Coverage: every builder that STILL carries a cleartext PIN/temp here must
--     have the matching HASH on its linked user. Expect orphans = 0. A non-zero
--     here means S1a didn't finish for someone — DO NOT run Block B until it's 0.
/*
SELECT count(*) AS orphans
FROM dev_field_ops_builders b
LEFT JOIN dev_field_ops_users u ON u.id = b.user_id
WHERE ( (NULLIF(b.pin_hash,'') IS NOT NULL AND u.pin_hash      IS NULL)
     OR (NULLIF(b.temp_pin,'') IS NOT NULL AND u.temp_pin_hash IS NULL) );
*/

-- A3. Sanity: how many builder rows still carry cleartext / lock state (context only).
/*
SELECT count(*) FILTER (WHERE NULLIF(pin_hash,'') IS NOT NULL) AS with_pin,
       count(*) FILTER (WHERE NULLIF(temp_pin,'') IS NOT NULL) AS with_temp,
       count(*) FILTER (WHERE is_locked)                       AS locked,
       count(*) FILTER (WHERE COALESCE(failed_attempts,0) > 0) AS with_attempts
FROM dev_field_ops_builders;
*/


-- ####################  BLOCK B — DEV SECTION (run once)  ####################
BEGIN;

DO $$
DECLARE missing text; orphans int;
BEGIN
  -- Pre-check 1: all 4 columns present (else already applied / wrong DB).
  SELECT string_agg(c, ', ') INTO missing
  FROM unnest(ARRAY['pin_hash','temp_pin','failed_attempts','is_locked']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='dev_field_ops_builders' AND column_name=c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: column(s) already gone on dev_field_ops_builders (%). Migration already applied?', missing;
  END IF;

  -- Pre-check 2: no builder depends on this as its ONLY credential copy.
  SELECT count(*) INTO orphans
  FROM dev_field_ops_builders b
  LEFT JOIN dev_field_ops_users u ON u.id = b.user_id
  WHERE ( (NULLIF(b.pin_hash,'') IS NOT NULL AND u.pin_hash      IS NULL)
       OR (NULLIF(b.temp_pin,'') IS NOT NULL AND u.temp_pin_hash IS NULL) );
  IF orphans > 0 THEN
    RAISE EXCEPTION 'ABORT: % builder(s) carry a cleartext PIN with no hash on dev_field_ops_users — migrate before dropping the only copy.', orphans;
  END IF;
END $$;

-- CLEAR first (defensive: a live writer would re-populate between clear and drop,
-- which the drop then surfaces rather than hides).
UPDATE dev_field_ops_builders
   SET pin_hash = NULL, temp_pin = NULL, failed_attempts = 0, is_locked = false
 WHERE NULLIF(pin_hash,'') IS NOT NULL
    OR NULLIF(temp_pin,'') IS NOT NULL
    OR COALESCE(failed_attempts,0) <> 0
    OR is_locked;

ALTER TABLE dev_field_ops_builders
  DROP COLUMN pin_hash,
  DROP COLUMN temp_pin,
  DROP COLUMN failed_attempts,
  DROP COLUMN is_locked;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- ####################  BLOCK C — VERIFICATION. Expect 1 row, PASS.  #########
/*
SELECT 'builder_pin_cols_dropped' AS check_name,
       (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='dev_field_ops_builders'
            AND column_name IN ('pin_hash','temp_pin','failed_attempts','is_locked'))::text AS actual,
       '0' AS expected,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='dev_field_ops_builders'
            AND column_name IN ('pin_hash','temp_pin','failed_attempts','is_locked')) = 0
            THEN 'PASS' ELSE 'FAIL' END AS status;
*/


-- ####################  ROLLBACK (re-adds EMPTY columns only)  ###############
/*
ALTER TABLE dev_field_ops_builders
  ADD COLUMN pin_hash        text,
  ADD COLUMN temp_pin        text,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN is_locked       boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
-- NOTE: cleartext values are NOT restored (intentional). The real hashed credential
-- is on dev_field_ops_users and was never touched.
*/
-- ============================================================================
