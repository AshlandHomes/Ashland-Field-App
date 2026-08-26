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
--  * GRANTS: new COLUMNS inherit the table's existing table-level grants
--    automatically — no re-grant needed (the notes table is already read/written
--    through the API, so its grants are table-level, not column-scoped). A
--    defensive re-grant is included COMMENTED below, to use only if the
--    API-visibility test somehow fails.
--  * NOTIFY pgrst reloads the PostgREST schema cache so the REST API sees the new
--    columns IMMEDIATELY (without it, columns exist in SQL but the API returns
--    null / "column does not exist" until the cache refreshes on its own).
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

-- Defensive re-grant — NORMALLY UNNECESSARY (new columns inherit table grants).
-- Uncomment ONLY if the API-visibility test fails:
-- grant select, insert, update on dev_sched_lot_task_notes to anon, authenticated, service_role;

-- Reload the PostgREST schema cache so the REST API sees the columns immediately:
notify pgrst, 'reload schema';

-- verify SQL existence (expect 4 rows):
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
--
-- -- defensive re-grant (normally unnecessary):
-- -- grant select, insert, update on sched_lot_task_notes to anon, authenticated, service_role;
--
-- notify pgrst, 'reload schema';
