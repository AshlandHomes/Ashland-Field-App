-- ============================================================================
-- Manager view — S1a: "PINs move to the person." ONE login for everyone.
-- ---------------------------------------------------------------------------
-- Every PIN (builders AND managers) lives on dev_field_ops_users, HASHED (bcrypt
-- via pgcrypto). This migration ADDS the hashed credential columns to the user
-- row and migrates each builder's existing PIN/temp-PIN (+ lock state) onto its
-- LINKED user, hashed. No plaintext lands in any new column.
--
-- SCOPE / SAFETY
--   * ADDITIVE ONLY. The old plaintext columns on dev_field_ops_builders
--     (pin_hash, temp_pin — misnamed; they hold CLEARTEXT today) are LEFT
--     UNTOUCHED for rollback and so builders' phones keep working exactly as they
--     do now (the field app still verifies against them until S1b flips the read).
--   * Field-ops-owned table only (dev_field_ops_users). ZERO LandIQ tables touched.
--   * No new grants — service_role already has full DML on dev_field_ops_users.
--     RLS deny-all stays. No anon/authenticated.
--   * Plain ALTER with a DO-block pre-check that RAISEs on ANY collision. No
--     IF NOT EXISTS. One transaction — all-or-nothing.
--   * bcrypt comes from pgcrypto's crypt()/gen_salt('bf'). Supabase ships pgcrypto
--     in the "extensions" schema; the block SETs search_path to find it whether it
--     lives in extensions or public. If the inventory shows it in some OTHER schema
--     (or missing), STOP and adjust — do not install anything.
--
-- Decisions locked: (A) one login path for all, admin env ADMIN_PIN unchanged until
-- DB separation. (B) a frozen baseline-completion date is a LATER step — nothing
-- here touches or presumes it.
-- ============================================================================


-- ####################  BLOCK A — INVENTORY (read-only; run FIRST)  ##########

-- A1. The 4 new column names must be FREE on dev_field_ops_users (expect 0 rows).
/*
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dev_field_ops_users'
  AND column_name IN ('pin_hash','temp_pin_hash','failed_attempts','is_locked')
ORDER BY column_name;
*/

-- A2. pgcrypto must be installed, and WHERE (schema). Expect 1 row; note the schema
--     (Supabase default = 'extensions'). ZERO rows => NOT available: STOP, tell me,
--     do not install anything.
/*
SELECT e.extname, n.nspname AS schema, e.extversion
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = 'pgcrypto';
*/

-- A3. Builder credential inventory + link integrity. pin_hash/temp_pin on BUILDERS
--     are the CURRENT CLEARTEXT. Expect builders_with_null_user = 0 (every builder
--     that has any credential MUST have a linked user_id, or the migrate can't place
--     it). Record builders_with_pin / builders_with_temp — the verification reuses them.
/*
SELECT
  count(*) FILTER (WHERE NULLIF(pin_hash,'')  IS NOT NULL)                        AS builders_with_pin,
  count(*) FILTER (WHERE NULLIF(temp_pin,'')  IS NOT NULL)                        AS builders_with_temp,
  count(*) FILTER (WHERE is_locked)                                               AS builders_locked,
  count(*) FILTER (WHERE (NULLIF(pin_hash,'') IS NOT NULL OR NULLIF(temp_pin,'') IS NOT NULL)
                         AND user_id IS NULL)                                     AS builders_with_cred_but_null_user,
  count(*) FILTER (WHERE user_id IS NULL)                                         AS builders_with_null_user
FROM dev_field_ops_builders;
*/


-- ####################  BLOCK B — MIGRATION (run once)  ######################
BEGIN;

-- Resolve crypt()/gen_salt() whether pgcrypto is in extensions or public.
SET LOCAL search_path = public, extensions, pg_temp;

-- Pre-flight: abort on ANY collision or missing prerequisite.
DO $$
BEGIN
  -- (a) none of the 4 new columns may already exist.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='dev_field_ops_users'
                AND column_name IN ('pin_hash','temp_pin_hash','failed_attempts','is_locked')) THEN
    RAISE EXCEPTION 'ABORT: one of pin_hash/temp_pin_hash/failed_attempts/is_locked already exists on dev_field_ops_users — migration already applied?';
  END IF;
  -- (b) pgcrypto bcrypt functions must be resolvable on the search_path set above.
  IF to_regprocedure('gen_salt(text)') IS NULL OR to_regprocedure('crypt(text, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT: pgcrypto crypt()/gen_salt() not found on search_path — check BLOCK A2 schema; do not install here.';
  END IF;
  -- (c) no builder may carry a credential without a linked user row to place it on.
  IF EXISTS (SELECT 1 FROM public.dev_field_ops_builders
              WHERE (NULLIF(pin_hash,'') IS NOT NULL OR NULLIF(temp_pin,'') IS NOT NULL)
                AND user_id IS NULL) THEN
    RAISE EXCEPTION 'ABORT: a builder has a PIN/temp PIN but no linked user_id — run the builder backfill first.';
  END IF;
END $$;

-- 1) ADD the hashed credential columns to the person (user) row.
ALTER TABLE public.dev_field_ops_users
  ADD COLUMN pin_hash        text,
  ADD COLUMN temp_pin_hash   text,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN is_locked       boolean NOT NULL DEFAULT false;

-- 2) MIGRATE each linked builder's cleartext PIN/temp PIN onto its user, HASHED.
--    Empty/blank => NULL (no credential). Each crypt() call generates its own salt,
--    so identical PINs produce different hashes. Lock state + attempts carry over.
UPDATE public.dev_field_ops_users u
   SET pin_hash        = CASE WHEN NULLIF(b.pin_hash,'') IS NOT NULL
                              THEN crypt(b.pin_hash, gen_salt('bf')) ELSE NULL END,
       temp_pin_hash   = CASE WHEN NULLIF(b.temp_pin,'') IS NOT NULL
                              THEN crypt(b.temp_pin, gen_salt('bf')) ELSE NULL END,
       failed_attempts = COALESCE(b.failed_attempts, 0),
       is_locked       = COALESCE(b.is_locked, false),
       updated_at      = now()
  FROM public.dev_field_ops_builders b
 WHERE b.user_id = u.id;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ####################  END MIGRATION  #######################################


-- ####################  BLOCK C — VERIFICATION. Expect 7 rows, all PASS.  ####
-- Standalone: set search_path so crypt() resolves here too.
/*
SET search_path = public, extensions, pg_temp;
WITH b AS (
  SELECT count(*) FILTER (WHERE NULLIF(pin_hash,'') IS NOT NULL) AS with_pin,
         count(*) FILTER (WHERE NULLIF(temp_pin,'') IS NOT NULL) AS with_temp
  FROM dev_field_ops_builders
),
u AS (
  SELECT count(*) FILTER (WHERE pin_hash IS NOT NULL)      AS with_pin,
         count(*) FILTER (WHERE temp_pin_hash IS NOT NULL) AS with_temp
  FROM dev_field_ops_users
),
checks AS (
            SELECT 'new_columns_present' AS check_name,
                   (SELECT count(*) FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='dev_field_ops_users'
                       AND column_name IN ('pin_hash','temp_pin_hash','failed_attempts','is_locked'))::text AS actual,
                   '4' AS expected
  UNION ALL SELECT 'pin_counts_match',
                   ((SELECT with_pin FROM u) = (SELECT with_pin FROM b))::text, 'true'
  UNION ALL SELECT 'temp_counts_match',
                   ((SELECT with_temp FROM u) = (SELECT with_temp FROM b))::text, 'true'
  UNION ALL SELECT 'no_plaintext_in_new_columns',   -- a new hash never equals the builder's cleartext
                   (SELECT count(*) FROM dev_field_ops_users u2 JOIN dev_field_ops_builders b2 ON b2.user_id=u2.id
                     WHERE (u2.pin_hash IS NOT NULL AND u2.pin_hash = b2.pin_hash)
                        OR (u2.temp_pin_hash IS NOT NULL AND u2.temp_pin_hash = b2.temp_pin))::text, '0'
  UNION ALL SELECT 'pin_hash_verifies_old',          -- crypt(old_plaintext, newhash)=newhash for every migrated PIN
                   (SELECT count(*) FROM dev_field_ops_users u2 JOIN dev_field_ops_builders b2 ON b2.user_id=u2.id
                     WHERE NULLIF(b2.pin_hash,'') IS NOT NULL
                       AND crypt(b2.pin_hash, u2.pin_hash) IS DISTINCT FROM u2.pin_hash)::text, '0'
  UNION ALL SELECT 'temp_hash_verifies_old',
                   (SELECT count(*) FROM dev_field_ops_users u2 JOIN dev_field_ops_builders b2 ON b2.user_id=u2.id
                     WHERE NULLIF(b2.temp_pin,'') IS NOT NULL
                       AND crypt(b2.temp_pin, u2.temp_pin_hash) IS DISTINCT FROM u2.temp_pin_hash)::text, '0'
  UNION ALL SELECT 'builder_plaintext_not_cleared',  -- old columns intact: no user has a hash whose builder lost its cleartext
                   (SELECT count(*) FROM dev_field_ops_users u2 JOIN dev_field_ops_builders b2 ON b2.user_id=u2.id
                     WHERE (u2.pin_hash IS NOT NULL      AND NULLIF(b2.pin_hash,'') IS NULL)
                        OR (u2.temp_pin_hash IS NOT NULL AND NULLIF(b2.temp_pin,'') IS NULL))::text, '0'
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks ORDER BY check_name;
*/


-- ####################  ROLLBACK (only if needed)  ###########################
-- Drops ONLY the 4 new columns. Builders' original plaintext columns were never
-- touched, so the field app keeps working through the rollback.
/*
BEGIN;
ALTER TABLE public.dev_field_ops_users
  DROP COLUMN IF EXISTS pin_hash,
  DROP COLUMN IF EXISTS temp_pin_hash,
  DROP COLUMN IF EXISTS failed_attempts,
  DROP COLUMN IF EXISTS is_locked;
COMMIT;
NOTIFY pgrst, 'reload schema';
*/
-- ============================================================================
