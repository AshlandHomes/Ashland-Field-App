-- ============================================================================
-- Red-flag resolution messaging — schema migration
-- Adds 4 columns to the notes table so a red-flag note can carry an admin
-- resolution request and the builder's response. The flag state is DERIVED:
--   open              flag='red', resolution_requested_at IS NULL
--   resolution-asked  flag='red', requested, resolution_response IS NULL
--   confirmed-open    flag='red', resolution_response='still_open'
--   resolved (kept)   flag='none', resolution_response='resolved'   (note row stays)
--
-- Notes:
--  * The notes table is dev/live isolated via TABLE_PREFIX: dev_sched_lot_task_notes
--    on Dev, sched_lot_task_notes on live. Run the DEV section now; the LIVE
--    section runs at promote time.
--  * ADD COLUMN IF NOT EXISTS is idempotent — safe to re-run.
--  * The CHECK keeps resolution_response to the two valid values (or NULL) so a
--    bad write can't create an undefined state (null-not-garbage discipline).
-- ============================================================================

-- ─────────────────────────── DEV ───────────────────────────
alter table dev_sched_lot_task_notes
  add column if not exists resolution_requested_at timestamptz,
  add column if not exists resolution_prompt        text,
  add column if not exists resolution_response      text,
  add column if not exists resolution_responded_at  timestamptz;

alter table dev_sched_lot_task_notes
  drop constraint if exists dev_sched_lot_task_notes_resolution_response_chk;
alter table dev_sched_lot_task_notes
  add  constraint dev_sched_lot_task_notes_resolution_response_chk
  check (resolution_response in ('resolved','still_open') or resolution_response is null);

-- verify (expect 4 rows):
-- select column_name, data_type
--   from information_schema.columns
--  where table_name = 'dev_sched_lot_task_notes'
--    and column_name like 'resolution_%'
--  order by column_name;


-- ─────────────────────────── LIVE (run at promote time — NOT now) ───────────────────────────
-- alter table sched_lot_task_notes
--   add column if not exists resolution_requested_at timestamptz,
--   add column if not exists resolution_prompt        text,
--   add column if not exists resolution_response      text,
--   add column if not exists resolution_responded_at  timestamptz;
--
-- alter table sched_lot_task_notes
--   drop constraint if exists sched_lot_task_notes_resolution_response_chk;
-- alter table sched_lot_task_notes
--   add  constraint sched_lot_task_notes_resolution_response_chk
--   check (resolution_response in ('resolved','still_open') or resolution_response is null);
