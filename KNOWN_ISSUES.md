# Known Issues — Ashland Field App

Deliberate, tracked inconsistencies to reconcile in their own steps (NOT during
the schedule-engine restructure, which must preserve behavior exactly).

## KI-1 — Field app and admin disagree on the CRITICAL SET (36 vs 51)

**Status:** open — reconcile after the engine restructure, with owner sign-off.
**Surfaced:** during Step 2 (schedule-engine extraction), parity testing on
Windermere Lot 1 / Slab template.

The field app computes the critical path as **pure CPM (float ≤ 0) → 36 tasks**
on the Slab schedule, because `openLot()` never loaded the `force_critical`
column, so the field engine never saw it.

The backend/admin critical writer (`recomputeTemplateCritical`) computes
**(float ≤ 0) OR force_critical → 51 tasks** (42 force_critical + 9
CPM-discovered), per BUILD_SPEC §2.6.

So a builder's field app and the admin console currently highlight **different
tasks as critical** for the same lot. This is a real product problem (the whole
point of the restructure is that the two surfaces agree), but fixing it is a
**behavior change**, not part of the engine extraction. The restructure
preserves each surface's existing critical semantics exactly (parity gate).

**Proposed fix (needs sign-off):** load `force_critical` into the field app and
have both surfaces use `(float ≤ 0) OR force_critical` — i.e. the field app
adopts the 51-task definition. Requires confirming the builder-facing critical
highlighting is expected to include force_critical tasks.

## KI-2 — Admin lots-list "planned completion" is a hardcoded 99-WD estimate

**Status:** open — reconcile after the restructure, with owner sign-off.
**Surfaced:** Step 2 (admin wiring).

`calcPlannedCompletion()` in `admin-dev.html` (lots list) shows
`construction_start + 99 working days` — a hardcoded constant that ignores the
lot's actual schedule. The real engine computes the Slab critical path at **94**
working days (planned), and each lot's projected end varies with actuals /
overrides. So the admin lots-list completion estimate can differ from the real
projected completion the field app shows.

The restructure only centralized the working-day math (the inline weekend-walk
now calls `ScheduleEngine.addWD`, output unchanged — still 99). Replacing the
hardcoded 99 with the engine's computed per-lot end is a **behavior change** for
a later step. Note: the per-task projected dates in the admin schedule view are
already correct (backend `computeLotProjected`); this KI is only the lots-list
summary column.
