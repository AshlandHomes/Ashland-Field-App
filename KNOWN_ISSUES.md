# Known Issues — Ashland Field App

Deliberate, tracked inconsistencies to reconcile in their own steps (NOT during
the schedule-engine restructure, which must preserve behavior exactly).

## KI-1 — Field app and admin disagree on the CRITICAL SET (36 vs 51)

**Status:** RESOLVED (root-caused 2026-08-07) — fix in `sql/2026-08-07_remove_force_critical.sql`,
applied to DEV first, LIVE section pending cutover.
**Root cause / resolution:** The 15-task gap was entirely `force_critical` — 15
of the template's 42 force flags sit on tasks that all have genuine positive
float (+10 to +19 WD), so they were never on the real critical path. **Origin of
the flags** (traced 2026-08-07; an earlier "Buildtopia import" guess was wrong
and is retracted): they predate the schedule-engine restructure —
`CLAUDE_CODE_BUILD_SPEC.md` records "42 force_critical" as pre-existing baseline
data. The only code path that writes `force_critical` is the admin builder
checkbox (`admin-dev.html:2669` → `supabase.js:537`); no seed, migration, clone,
default, or automated process sets it (clone omits it; recalc writes only
`is_critical`). So cleared flags do not silently return — the sole re-introduction
vector is that admin checkbox, which should be removed. Clearing `force_critical` collapses backend `is_critical` (51) to the pure
float-based set (36), matching the field app's `_crit` exactly (verified on the
real Slab graph: after clearing, `is_critical` set === `_crit` set === 36,
projectEnd unchanged at 94). The owner chose to remove `force_critical` entirely
(no legitimate use; the predecessor graph already computes the true critical
path). **force_critical was then removed from the code entirely (2026-08-07):**
the engine computes is_critical = pure float ≤ 0, the backend recalc lands on the
same 36 on its own (proven inert in test/force-critical-removal.js — the flag
can't force anything), and the admin "always treat as critical" checkbox + all
reads/writes are gone. The DB column is left in place (dropping is riskier) but is
no longer read or written. Remaining follow-up: recompute `is_critical` on
already-stamped lot tasks (they carry the old 51-set until re-stamped/recomputed).
The legitimate "watch inspections/milestones" need lives on as KI-8 (a separate,
deliberate indicator — never a force_critical revival).

--- historical context (original filing) ---
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

**Status:** RESOLVED (Dev, 2026-08-21) — option C, single-source completion.
**Surfaced:** Step 2 (admin wiring). **Fix:** whole-system date audit (all dates
trace to the stamped schedule via the one engine; the flat-99 was the only
headline rogue — see KI-10 for the second, low-severity one).

The rogue `calcPlannedCompletion()` = `construction_start + 99 WD` ignored the
lot's schedule entirely (only the start date), so it never moved with est /
predecessor edits and disagreed with the field app's real completion.

**What changed:**
- `schedule-engine.js`: new `computeLotSchedule(tasks, startDate)` runs the ONE
  engine over the lot's stamped tasks in BOTH modes and returns
  `{planEnd, projEnd, planEndDate, projEndDate}` (projected == field app; planned
  == CPM baseline).
- `supabase.js` `getAllLotPhases`: calls it per lot, returns `planEndDate` +
  `projEndDate` in the snapshot.
- `admin-dev.html`: lots-table completion column + CSV export now read those
  engine dates (projected primary, baseline secondary); `calcPlannedCompletion`
  **deleted** (both call sites). `reloadLots()` now refetches `lotPhases` so the
  completion refreshes after edits (was the re-freeze trap).
- Non-active lots (no `getAllLotPhases` entry) show "—" (their date is the Close
  column), not a fabricated projection.

**Proof:** `test/admin-completion-parity.js` (admin projEnd === field app projEnd
and planned baseline; est push MOVES projected 11/20→12/04, baseline unchanged;
old flat-99 11/30 ≠ real 11/20) + `test/admin-completion-render-browser.js` (real
`renderLotsTable` shows the engine dates and re-renders live). Full suite green.

## KI-3 — Backend recomputes CPM per request (perf)

**Status:** open — do NOT optimize yet; let it settle, then profile first.
**Surfaced:** Step 2 dev validation — schedule load/save feels slightly slower
since the restructure.

The backend now runs the shared CPM engine on every relevant request. In
particular `getAllLotPhases` calls `computeLotProjected` for **every active lot
on every call** (previously the same inline work, but worth confirming it's the
hotspot). Likely-fine at current lot counts, but it scales with lot count × call
frequency.

**When we optimize (not now):** profile where the time actually goes before
changing anything — is `getAllLotPhases` the hotspot? Candidate approaches once
measured: compute per-lot only when that lot's tasks changed (cache the projected
snapshot, invalidate on task write) instead of recomputing all lots every call;
or compute lazily per opened lot. Measure first — do not pre-optimize.

## KI-4 — No guard against "finished task with an unstarted predecessor"

**Status:** open — future enhancement (not a bug in the engine).
**Surfaced:** Step 2 dev validation — stale test data on Lot 1 had #84 marked
finished (pinned to construction start) while its predecessor #79 sat unstarted.

The engine correctly honors actuals over predecessor projection, so a
fat-fingered "finished" with an actual date produces a real-but-nonsensical
schedule (a task complete before the work that feeds it has begun). The app
should detect and flag this impossible state — a task `finished`/`started`
whose predecessor is not yet `started`/`finished` — as a data-integrity
warning in the field app and/or admin, so dirty data surfaces instead of
silently distorting the schedule. (The parity harness already has a version of
this check; promote it into the app.)

**Critical design note (from the Phase-0 live audit):** the warning MUST exempt
**negative-lag (lead-time) tasks** from the "finished/started before predecessor"
check. An "Order/Deliver X" task with negative lag legitimately completes before
its predecessor ("Install X") — that is correct lead-time history, not an error.
Flagging those is a false positive. Only flag: (a) a started/finished task whose
predecessor is not_started, and (b) out-of-sequence actuals on **non-negative-lag**
tasks. The pre-cutover audit SQL intentionally did not encode this exemption (it
erred toward over-reporting for a human to filter); the in-app warning should.

## KI-5 — GitHub Pages published a broken second live surface — RESOLVED

**Status:** resolved / actioned (2026-08-02). GitHub Pages disabled; Netlify is
the sole live surface.
**Surfaced:** Phase-4 live cutover — pushing `main` triggered a GitHub Pages
build (GitHub's managed "pages build and deployment", no workflow file in-repo)
*in addition to* the Netlify deploy.

`main` was auto-publishing to two live surfaces: Netlify (`ashland-field-ops`,
the real app) and GitHub Pages (`github.io`). The Pages copy served the static
HTML, but its `/.netlify/functions/supabase` calls have no backend on the Pages
domain — so it would **load but fail to fetch any data** (a broken shell) for
anyone hitting the Pages URL. A second, broken production surface is a real
liability and a future-confusion/drift risk.

**Resolution:** GitHub Pages disabled (Settings → Pages → Source: None). Netlify
(`ashland-field-ops`) is the single live surface going forward — consistent with
the single-source-of-truth model (`DEPLOY.md`): one editable source, one live
surface.

## KI-6 — No builder-facing way to backdate an actual to a real past date (UX)

**Status:** open — future enhancement (validation is already ready for it).
**Surfaced:** actual-date entry-block work.

The field app's Start/Finish buttons open the date picker defaulting to today, and
a builder catching up on real past work needs to enter the *real* past dates. The
entry-block validation **already allows** any actual in `[construction_start, today]`,
so a backdated-but-valid date passes — but the UX doesn't make backdating obvious
(and there's no dedicated "log completed work with its real date" flow), so a
builder may feel forced to today. Without an easy backdate path, catch-up (e.g.
Brendon's Ruby Creek legacy lots) risks recreating the bulk-stamp / out-of-sequence
problem.

**When we build the backdate UI (not now):** the validation is the right shape
already — it permits `construction_start ≤ date ≤ today` and blocks outside it, so
the UI just needs to surface picking a past date within that window (and finish ≥
start). No validation change required.

## KI-7 — `addWD` has a 1-based OFFSET convention, and a second 0-based copy exists

**Status:** open — do NOT change it (behavior is consistent and validated). TRACK
it. This is the **first thing to audit if we ever see a one-day drift anywhere.**
**Surfaced:** proving the started-task projected-finish display (FIX #1). A
cross-check that used `addWD` directly disagreed with the rendered date by one
working day — the render was right; the check misused the helper.

**The quirk.** The shared engine's `addWD(start, off)` (schedule-engine.js:29) is
**1-based / offset-based**: `off` is the working-day OFFSET where **`off === 1`
returns the start date itself**. So `addWD(Fri, 1) = Fri` and `addWD(Fri, 2) =
Mon`. It is NOT "add `off` working days." This is deliberate and internally
consistent — it is the exact inverse of `offToDate`/`actOffset`, and the engine's
elapsed-time offsets (`es`/`ef`) are 1-based (day 1 = construction start). Every
in-engine use is offset-correct:
- `offToDate(off) = addWD(startDate, off)` (schedule-engine.js:57)
- projected date `addWD(startDate, es[num])` (schedule-engine.js:234)
- admin planned-completion `addWD(date, 100)` = the 100th working day (admin-dev.html:1206)

So a task spanning `duration` working days from an offset `o` finishes at offset
`o + duration - 1`, and its date is `offToDate(o + duration - 1)`. Use the
**offset math** (or `offToDate`) for finish dates — never `addWD(actual_start,
duration - 1)`, which is off by one because of the 1-based convention.

**The second copy (the real trap).** Despite the engine header's rule "never
define a second `addWD`/`wdBetween` anywhere," the backend `getStaleCriticalTasks`
defines a **local** `addWD` (netlify/functions/supabase.js:666) with a
**different, 0-based** convention: `off === 0` returns the start date (`// off=0
=> same day`), i.e. it genuinely adds `off` working days. It is used there as
`addWD(eligible, dur + GRACE)` and is correct *for that 0-based helper*. But two
same-named helpers with off-by-one-different conventions is a latent drift bug: if
anyone ever "consolidates" the backend copy onto the shared engine's `addWD`
without shifting the argument (`off` → `off + 1`, or `dur` → `dur - 1`), the stale-
task threshold silently moves by a day.

**Audit-first checklist if a one-day drift appears anywhere:**
1. Which `addWD` is the call site using — engine (1-based, `off=1`→start) or the
   backend local (0-based, `off=0`→start)?
2. Is the argument an OFFSET (use engine `addWD`/`offToDate`) or a COUNT of days to
   add (use the 0-based form)? Mismatch = one-day error.
3. When we do unify (future cleanup): pick ONE convention, delete the backend
   local copy, and shift every call site's argument to match. Add a test asserting
   `addWD(anyWeekday, 1) === anyWeekday` so the convention can't silently flip.

## KI-8 — Inspections/milestones may deserve a deliberate "watch" indicator

**Status:** open — future refinement, to be DESIGNED intentionally (not inherited
from import flags).
**Surfaced:** the `force_critical` removal (2026-08-07). The 15 cleared flags were
disproportionately inspections/milestones (CO inspection #140, drywall/cabinet/
trim/tile/paint finish milestones). The original import labeled them "critical"
even though the CPM engine computes them with real float.

Some of those tasks — inspections especially — have **external dependencies CPM
doesn't model** (a third-party inspector's calendar, a utility's release, a permit
office), so a builder may legitimately want them highlighted to "watch" even when
the math says they have slack. That is a **separate, deliberate concept** from the
computed critical path and the delay trigger — NOT a reason to keep stale
`force_critical` flags.

**When we build it (not now):** design an explicit, owner-controlled "watch /
external-dependency" marker with its own semantics and its own visual (distinct
from the float-critical red dot), decided task-by-task on purpose. Do NOT resurrect
`force_critical`, and do NOT fold it into the delay trigger (which stays keyed to
the float-based `_crit` — only completion-threatening lateness prompts a reason).

## KI-9 — Today-floor for not-started tasks + manual-override (est_start_date) flag

**Status:** IN PROGRESS — this is one "earliest-start story," built incrementally.
Same code area (`schedule-engine.js` + the field app's est handling), so the pieces
share a foundation and ship across promotes.
**Surfaced:** WI Lot 1 "9 days behind" diagnosis (2026-08-11).

### Shared foundation — `earliestStart(task, computed)` [DONE, Dev, 2026-08-20]
`schedule-engine.js` now exports `earliestStart(task, computed) -> {offset,
bindingPred} | null`: the earliest working-day offset a task can start given its
predecessors, plus which predecessor binds it. Honors lag sign EXACTLY like
`computeSchedule`'s driver (lag≥0 → `max(ef+1+lag)` from predecessor FINISH; lag<0 →
`min(es+lag)` lead time from predecessor START), floored at offset 1, null when no
predecessor constrains. `computed` is a `{num:{es,ef}}` map the CALLER supplies —
so the *earliest-start logic* is single-source, the *reality it's measured against*
(planned vs projected) is the caller's choice, same pattern as `computeSchedule(mode)`.
Proven by `test/earliest-start.js`: `earliestStart.offset === planned engine es`
for all 127 predecessor tasks + neg-lag #69 (lag −9 → es[71]−9) + binding-pred + no-pred.

**ARCHITECTURAL RULE (owner-confirmed):** the today-floor, active/inert flag, and
delay rule below MUST all call `earliestStart` — ONE earliest-start computation
feeding all readers, same discipline as the single schedule engine. They differ
only in what they COMPARE against it (today / the override / the actual start).
If any of them grows its own predecessor loop, that is the bug.

### Earliest-start story — where we are
- **DONE (Dev):** block impossible-early est override in `saveEditTask` — an est
  earlier than `earliestStart` is blocked (not silent-floored) with a modal naming
  the binding predecessor + the engine's real earliest date, neg-lag-aware wording,
  and an unlink path. Proof: `test/est-block-browser.js`. Rides to live with the
  rest of KI-9 in a future promote (not shipped live standalone).
- **REMAINING (all reuse `earliestStart`):** Part A today-floor · Part B active/inert
  override flag · the delay rule (`actualStart > earliestStart` ⇒ started late).

### Part A — today-floor (was "Task 2")
[VERIFIED from code] the engine has NO today-floor: a not-started task projects at
its predecessor/relative/est position, never floored to today (`todayOff` is
computed only for the "weeks out" stat, never fed to the engine). So a lot where
nothing has started reports **On track** when it is really weeks behind.

**Build:** in `computeSchedule` **projected mode only**, add an opt-in `today`
param. For a **not-started** task, after the predecessor/relative + est floors,
apply `start = max(start, actOffset(today, startDate))`. Stacks as
`max(predecessor, estFloor, todayFloor)`: an est in the PAST is subsumed by today,
an est in the FUTURE still wins. Started/finished tasks untouched (actuals are
truth). Field app passes `today` into `runEngine('projected')` ONLY — planned mode
never gets it, so `planEnd` (the baseline) and the health delta stay meaningful.

### Part B — manual-override flag
[CODE — verified] the override marker already exists: **`est_start_date IS NOT
NULL`**. NULL = calculated; non-null = a human deliberately overrode. The edit
modal DISPLAYS the calculated projected start as a prefill (so the field is never
blank), but the save-guard (`ashland-stage-update-dev.html:1190-1198`) writes NULL
unless the user changed it away from that prefill. There is NO separate override
flag; `vendor_confirmed` is a *second* layer ("builder locked this override"),
not the detection. Detection = `est_start_date IS NOT NULL`. **Gate before relying
on it fleet-wide:** confirm the column is sparse (no bulk op wrote calculated
dates) — run the non-null-count check across `sched_lot_tasks`.

**Build:** flag every task with a non-null `est_start_date` (past OR future).
Per the icon rule, hover/click explains: "Manual start override: [date].
Calculated start: [date]." Distinguish **ACTIVE** overrides (the est floor
actually raises the projected start / moves a downstream date — detect by
comparing projected-with-est vs projected-without-est) from **INERT** ones (set
but no effect, e.g. a task with no dependents like #3 on WI Lot 1) — show both,
mark which actually move dates. Add a lot-level indicator ("N manual overrides on
this lot") so a surprising number has an obvious place to look. `vendor_confirmed`
may change how the flag renders (locked vs unconfirmed), but is not the detection.

### Verified anchor (WI Lot 1, id b84172bc-…, 2026-08-11)
Not stamped. Nothing started. `est_start_date` set on exactly 2 tasks
(`have_est=2/129`). **#2 Silt Fence est=2026-07-27** floors the schedule root from
offset 1 (Jul 14) → offset 10 (Jul 27) = **+9 WD**, cascading the whole critical
path → planEnd 94 vs projEnd 103 → **"9 days behind"** [VERIFIED by recompute on
the pasted data — reproduced exactly]. With the today-floor (today = offset 21),
#2 would floor to today → **~20 behind** (the correct number for a lot with
nothing started in 21 working days). The second est (bt_num > 75) is inert.

**NOT bundled:** KI-4 (out-of-sequence actuals) is a separate concern about bad
actuals, not not-started projection or overrides. Do not fold it into this work.

## KI-10 — Stale-task "was due" date is computed outside the one engine

**Status:** logged — decide (i) vs (ii) when building the today-floor (KI-9).
**Severity:** LOW — a diagnostic label on the admin "Stale" indicator, not a
headline schedule date. **Surfaced:** whole-system date audit (2026-08-21), the
second rogue found alongside the flat-99 (KI-2).

`getStaleCriticalTasks` (`supabase.js`) computes
`expected_done = addWD(eligible_predecessor_actual_finish, duration + GRACE)` and
the admin shows it as "was due [date]" (`admin-dev.html`, stale modal). That
derived date does **not** route through `computeSchedule` over the stamped
schedule, so by the one-calculation rule it is rogue. Unlike the flat-99 it isn't
masquerading as the schedule — it's a staleness heuristic ("should this have been
done by now?") with a deliberate 3-WD grace window, anchored on when the task
*actually* became unblocked.

**Two fixes (owner to pick when the today-floor lands):**
- **(i)** Redefine staleness as **engine projected-finish-in-past**: task's
  projected `ef` < today and not finished. Fully single-source; drops the grace
  window; depends on the KI-9 today-floor to be meaningful.
- **(ii)** Keep the grace heuristic but **stop displaying the "was due [date]"** —
  show only "N working days overdue". No rogue *date* is shown; diagnostic
  survives. Cheap, no KI-9 dependency.

Decide (i) vs (ii) in the KI-9 / today-floor session, since (i) needs it.

## KI-11 — No distinct "actual closed-on" date (scheduled_close_date is overloaded)

**Status:** logged — small future follow-up, NOT needed now.
**Surfaced:** admin Close-column date display (2026-08-21).
**Severity:** LOW — the current display is correct for the normal close flow.

`scheduled_close_date` is a single overloaded field: the TARGET close date while a
lot is active, and the close date once closed (both close paths — `closingMarkClosed`
and `toggleLotClosed` — write it, defaulting to today if none). The admin Close
column now shows it under the "🏠 Closed" badge. This is correct when the operator
closes on/at the date they entered. **Edge:** a *quick-close* from the list reuses
whatever target was set, so if that target was stale, the displayed close date would
be that stale target, not the true day it closed.

**Follow-up (when wanted):** capture a genuine actual close date distinct from the
target — either a new `closed_at` / `actual_close_date` column, or always stamp
today on close. Then the Close column shows the real closed-on date regardless of a
stale target. Not urgent; the normal close flow is accurate today.

## KI-12 — (trivial future option) fold canceled lots into the bottom group too

**Status:** logged — trivial, do only if wanted.
**Surfaced:** admin closed-lots collapse group (2026-08-21).

The lots table now collapses `status==='closed'` lots into a bottom "🏠 Closed (N)"
group (`renderLotsTable`, display-only). Canceled lots stay interleaved — canceled
is rare and semantically different from closed. If ever wanted, generalize the
group to all-inactive (`status !== 'active'`) with a relabel (e.g. "Closed /
Canceled"), or a second group. One-line filter change; no data impact.
