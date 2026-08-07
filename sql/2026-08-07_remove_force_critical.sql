-- ============================================================
-- REMOVE force_critical — resolves KI-1 (field 36 vs backend 51 critical set)
--
-- WHY: The Slab template carries 42 `force_critical=true` flags; 15 of them are
-- on tasks with GENUINE POSITIVE FLOAT (+10 to +19 working days), so those 15 are
-- not on the real critical path — they only read as "critical" because
-- force_critical ADDs to the computed set. Clearing all 42 collapses backend
-- `is_critical` (51) down to the pure float-based critical path (36) — exactly
-- what the field app already computes for `_crit` (the red dot / delay trigger).
-- One fix, KI-1 gone.
--
-- ORIGIN of the flags (traced 2026-08-07, do not repeat earlier guesses): they
-- PREDATE the schedule-engine restructure — CLAUDE_CODE_BUILD_SPEC.md documents
-- "42 force_critical" as pre-existing baseline data. The ONLY code path that
-- writes force_critical is the admin builder checkbox (admin-dev.html:2669 ->
-- supabase.js:537). No seed/migration/clone/default/automated process sets it
-- (cloneTemplate omits it; recalc writes only is_critical). So once cleared they
-- do NOT come back on their own; the sole re-introduction vector is that admin
-- checkbox, which should be removed.
--
-- SAFE: `force_critical` lives ONLY on template tasks (never copied to lots).
-- Neither the red dot nor the delay trigger reads it — both use the field app's
-- live float. Clearing it changes only the stored backend `is_critical` value.
--
-- SOURCE OF TRUTH: this file lives in the repo. Apply to DEV first (dev_ prefix),
-- verify the counts, THEN apply the LIVE section at cutover.
--
-- Slab template_id = 9fae6f78-d2b5-4d57-9e09-8622d37cd829
--
-- The 15 force-only tasks (is_critical TRUE only via force_critical; float > 0):
--   62 Insulation-Batts, 69 Drywall Delivery, 71 Drywall Install, 79 Cabinets,
--   84 Trim & Doors, 88 Tile, 92 Drywall Prime Touch-up, 95 Final Paint,
--   99 Granite, 104 Plumbing Trim, 108 HVAC Trim, 110 Electrical Trim,
--   119 Rough Clean, 123 Hardwood, 140 CO Inspection.
--
-- Step 2 hard-codes those 15 for an immediate, deterministic result. It is
-- equivalent to running recalcTemplateCriticalPath after step 1 — now that
-- force_critical is cleared, that recompute independently yields the same 36,
-- so the app self-heals on any future template edit.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- DEV  (TABLE_PREFIX = dev_)  —  RUN THIS FIRST, verify, then stop.
-- ─────────────────────────────────────────────────────────────

-- 1. Clear the force_critical overrides.
UPDATE dev_sched_template_tasks
   SET force_critical = false
 WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829'
   AND force_critical = true;

-- 2. Drop the 15 force-only tasks out of is_critical (the 36 zero-float tasks
--    are already is_critical=true and are left untouched).
UPDATE dev_sched_template_tasks
   SET is_critical = false
 WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829'
   AND bt_num IN (62,69,71,79,84,88,92,95,99,104,108,110,119,123,140);

-- 3. VERIFY — expect force_remaining = 0 and is_critical_count = 36.
--    If either is off, do NOT proceed to LIVE; flag it.
SELECT
  count(*) FILTER (WHERE force_critical) AS force_remaining,    -- expect 0
  count(*) FILTER (WHERE is_critical)    AS is_critical_count,  -- expect 36
  count(*)                                AS total_tasks         -- expect 129
FROM dev_sched_template_tasks
WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829';


-- ─────────────────────────────────────────────────────────────
-- LIVE  (TABLE_PREFIX empty)  —  RUN ONLY AFTER DEV VERIFIES.
-- Identical logic against the unprefixed tables.
-- ─────────────────────────────────────────────────────────────

-- UPDATE sched_template_tasks
--    SET force_critical = false
--  WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829'
--    AND force_critical = true;
--
-- UPDATE sched_template_tasks
--    SET is_critical = false
--  WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829'
--    AND bt_num IN (62,69,71,79,84,88,92,95,99,104,108,110,119,123,140);
--
-- SELECT
--   count(*) FILTER (WHERE force_critical) AS force_remaining,
--   count(*) FILTER (WHERE is_critical)    AS is_critical_count,
--   count(*)                                AS total_tasks
-- FROM sched_template_tasks
-- WHERE template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829';
