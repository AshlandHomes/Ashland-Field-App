-- Parity-harness fixture puller — run in the dev Supabase SQL editor.
-- Returns ONE json cell: { template_tasks:[...], lot:{...}, lot_tasks:[...] }.
-- Reads dev_ tables only. Finds Windermere Lot 1 by name (no UUID hunting).
-- Copy the single result cell and paste it back to Claude.
select json_build_object(
  'template_tasks', (
    select coalesce(json_agg(t order by t.task_order), '[]'::json) from (
      select bt_num, name, duration, lag, relative_start, relative_finish,
             predecessors, force_critical, is_critical, task_type, task_order,
             trade, phase_id
      from dev_sched_template_tasks
      where template_id = '9fae6f78-d2b5-4d57-9e09-8622d37cd829'   -- Slab template (spec §4)
    ) t
  ),
  'lot', (
    select json_build_object(
      'id', id, 'lot_number', lot_number, 'community', community,
      'status', status, 'construction_start_date', construction_start_date,
      'template_id', template_id)
    from dev_sched_lots
    where (community ilike 'wi%' or community ilike 'windermere%')
      and lot_number ~ '(^|[^0-9])1$'          -- ends in 1, not preceded by a digit (Lot 1, not Lot 11/21)
    order by lot_number
    limit 1
  ),
  'lot_tasks', (
    select coalesce(json_agg(t order by t.task_order), '[]'::json) from (
      select bt_num, name, status, phase_order, phase_name, task_order,
             is_critical, force_critical, task_type, trade, est_start_date,
             actual_start, actual_finish, vendor_confirmed,
             relative_start, relative_finish, duration, lag, predecessors
      from dev_sched_lot_tasks
      where lot_id = (
        select id from dev_sched_lots
        where (community ilike 'wi%' or community ilike 'windermere%')
          and lot_number ~ '(^|[^0-9])1$'
        order by lot_number limit 1
      )
    ) t
  )
);
