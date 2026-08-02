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
