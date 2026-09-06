-- ============================================================================
-- Hold Gates — schema migration (piece 1 of the Hold Gates build)
--
-- Generalizes the existing utility-gate mechanism into configurable, named
-- "hold gates." The block/release/snap ENGINE already exists (computeStage caps
-- the reported stage while gates are open, snaps to the true computed stage when
-- they release). This migration only adds the two fields that were MISSING to
-- make gates generic + multi-threshold:
--
--   status_message     — user text surfaced to sales in the status column + export
--                        ("Do not schedule closing"). NULL = no message.
--   hold_task_bt_nums  — the schedule tasks (by bt_num) attached to this gate.
--                        The gate RELEASES when every one of these tasks is
--                        finished on the lot (task-driven, DERIVED — no stored
--                        per-lot gate state, same compute-on-read discipline as
--                        stages). Empty '{}' = legacy manual-confirm gate
--                        (released via sched_lot_gate_state.confirmed), so the
--                        existing utility gates keep working untouched.
--
-- The per-gate THRESHOLD already exists as sched_template_gates.hold_stage_code
-- (today every row is '5.9'; the engine hardcodes 5.9 and will be changed to
-- read this column per gate). No schema change needed for the threshold.
--
-- Notes:
--  * dev/live isolation is via TABLE_PREFIX: dev_sched_template_gates on Dev,
--    sched_template_gates on live. Run the DEV section now; LIVE runs at promote.
--  * ADD COLUMN IF NOT EXISTS is idempotent — safe to re-run.
--  * integer[] with NOT NULL DEFAULT '{}' backfills every existing gate row to
--    "no attached tasks" = manual-confirm — preserves current live behavior.
--  * New columns inherit the table's existing table-level grants — no re-grant.
--  * NOTIFY pgrst reloads the PostgREST cache so the REST API sees the columns
--    immediately (without it the API returns "column does not exist" until the
--    cache refreshes on its own).
-- ============================================================================

-- ─────────────────────────── DEV (run now) ───────────────────────────
alter table dev_sched_template_gates
  add column if not exists status_message    text,
  add column if not exists hold_task_bt_nums integer[] not null default '{}';

-- Reload the PostgREST schema cache so the REST API sees the columns immediately:
notify pgrst, 'reload schema';

-- verify (expect 2 rows: status_message=text, hold_task_bt_nums=ARRAY):
-- select column_name, data_type
--   from information_schema.columns
--  where table_name = 'dev_sched_template_gates'
--    and column_name in ('status_message','hold_task_bt_nums')
--  order by column_name;


-- ─────────────────────────── LIVE (run at promote time — NOT now) ───────────────────────────
-- alter table sched_template_gates
--   add column if not exists status_message    text,
--   add column if not exists hold_task_bt_nums integer[] not null default '{}';
--
-- notify pgrst, 'reload schema';
--
-- -- verify (expect 2 rows):
-- -- select column_name, data_type
-- --   from information_schema.columns
-- --  where table_name = 'sched_template_gates'
-- --    and column_name in ('status_message','hold_task_bt_nums')
-- --  order by column_name;
