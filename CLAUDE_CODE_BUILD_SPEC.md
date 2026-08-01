# Ashland Field App — Schedule Engine Restructure: Claude Code Build Spec

**Status:** The app is LIVE in UAT with real builders using it. It works. This is NOT a from-scratch rewrite. It is a **disciplined restructure** that extracts proven logic into a cohesive, modular, scalable architecture while preserving 100% of current behavior. Behavior parity against real data is the acceptance test. Nothing goes live until the new version produces identical output to the current one on real lots.

**Read this entire document before writing any code.** Then propose a plan and wait for the owner (Collin) to approve it before implementing.

---

## 0. WHO / HOW TO WORK

- **Owner:** Collin Steinberger — builds residential homes, runs Ashland Homes + Stephen Elliott Homes as a one-man back office. Voice-dictates; read for intent. Wants: truth over agreement, no yes-manning, honest pushback, one verified step at a time, NO batched changes, foundations built right not patched. He is technical and has used Claude Code before.
- **The prime directive that motivated this whole spec:** stop the patchwork. The app currently has the schedule engine **duplicated by hand** in multiple files, and those copies have drifted, producing dates that disagree between the builder app and the admin console. That drift is the #1 problem to eliminate permanently.
- **Test discipline:** prove every change against REAL data before presenting it. Do not say "this should work" — run it. Close the loop yourself (query Supabase, compute, compare) rather than asking Collin to be the test harness.

---

## 1. THE PRIME ARCHITECTURAL GOAL — ONE SHARED ENGINE

There must be exactly **one** schedule engine, in **one** file, that every surface calls:

```
schedule-engine.js   (single source of truth — pure, no DOM, no DB, no side effects)
    ├── field app  (ashland-stage-update.html)  imports & calls it
    ├── admin app  (admin.html)                 imports & calls it
    ├── backend    (netlify/functions/supabase.js) imports & calls it
    └── template builder (in admin)             imports & calls it (validation + preview)
```

**Why:** the current bug is two hand-synced copies diverging. A shared module makes divergence *impossible* — one function, one file, N callers, identical output guaranteed.

**The stack wrinkle you must solve:** the frontend is plain HTML with `<script src>` (NO build step, NO bundler). The backend is a Netlify Function using CommonJS `require()`. So `schedule-engine.js` must work BOTH as a browser global (via `<script src>`) AND as a Node module (via `require`). Use a UMD-style wrapper:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScheduleEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ... pure engine here ...
  return { computeSchedule, validateSchedule, /* helpers */ };
}));
```

Do NOT introduce a build step, bundler, or framework for the existing app. Keep it plain JS. (A future ERP shell may use React/TS — out of scope here.)

---

## 2. THE ENGINE SPEC (proven correct — implement exactly)

The CPM math below was validated against real data. Implement it faithfully. It is a **working-day** engine: weekends excluded, **offset 1 = the construction start date itself**.

### 2.1 Inputs (per task)
```
num              unique task number (int)
name             string
duration         working days (int >= 1)
lag              int, may be NEGATIVE (see below)
predecessors     array of task nums
relative_start   original planned start offset (FALLBACK only — see 2.4)
task_type        'work' | 'action'
status           'not_started' | 'started' | 'finished'
actual_start     YYYY-MM-DD or null
actual_finish    YYYY-MM-DD or null
est_start_date   YYYY-MM-DD or null   (manual OVERRIDE / floor — see 2.5)
force_critical   bool (manual add to critical set)
```
Plus the lot's `construction_start_date` (YYYY-MM-DD) to convert offsets↔dates.

### 2.2 Working-day helpers (must match exactly — off-by-one here caused real bugs)
```
addWD(start, off):   offset 1 == start date; count forward skipping Sat/Sun.
wdBetween(a, b):     signed working-day count between two dates.
actOffset(iso):      wdBetween(construction_start, iso) + 1   (null if either missing)
offToDate(off):      inverse of addWD; must handle off < 1 by walking backward.
```
**CRITICAL LESSON:** a duplicate `wdBetween` once shadowed the real one and silently broke every date calc. In the single module there is exactly ONE of each helper. Never define a second. (Grep for duplicate function names as a habit.)

### 2.3 Start-offset rule (the heart of it)
For each task, earliest start `es` is determined in this priority order:

1. **If started/finished (actual):** `es = actOffset(actual_start)`. Actuals are truth; they bypass predecessor projection.
2. **Else if lag < 0 (LEAD TIME / negative lag):** schedule BACKWARD from the predecessor's **START**:
   `es = min over preds( predecessorStart + lag )`   (lag negative → earlier)
   Reference point is the predecessor's **start**, not finish. (Confirmed by owner.)
3. **Else (forward, lag >= 0):** from the predecessor's **FINISH**:
   `es = max over preds( predecessorFinish + 1 + lag )`
4. **If no predecessors at all:** `es = relative_start` (fallback only, see 2.4).
5. **est_start_date override:** if not started and `est_start_date` set, apply as a FLOOR:
   `es = max(es, actOffset(est_start_date))`. Override raises the floor; upstream can still push later.
6. **Global floor:** `if (es < 1) es = 1`. **Nothing schedules before the construction start date. Ever.** (Confirmed by owner — even a long lead time clamps to day 1.)

Finish: `ef = (finished ? actOffset(actual_finish) : es + duration - 1)`.

### 2.4 relative_start is a FALLBACK, not a FLOOR
`relative_start` is used ONLY when a task has no predecessor driver. It is the task's original planned position for un-chained tasks. It must NOT act as a floor on tasks that have predecessors — a competing fixed floor stops the cascade (this was a real divergence between the two old engines: the backend treated it as a floor, the field app as a fallback). The correct model is fallback-only. **Consequence to communicate:** until every task has a predecessor, some currently-unchained tasks will move earlier than their old fixed dates. That is expected and correct; it resolves once the predecessor network is complete (see §4).

### 2.5 est_start_date = override floor (the "95% model")
A builder can override a task's start in the field. It acts as a **floor** ("no earlier than this"), not a hard pin — upstream slips can still push the task later. DISPLAY RULE: the app must show start and finish BOTH derived from the engine's computed `es` (finish = es+dur-1). Do NOT display the literal override for start while taking finish from the engine — that produced an impossible "start after finish." One computed `es` drives both.
- **Deferred (do NOT build now, note as future):** a HARD PIN (lock a date exactly, don't let upstream move it) plus a CONFLICT FLAG when a committed date and the computed schedule diverge. Start floor-only (~95% of cases).

### 2.6 Critical path (preserve existing behavior)
- Backward pass (late start/finish), float = LS − ES, critical when float ≤ 0.
- `force_critical` ADDS tasks to the critical set (manual override) — it never removes.
- Validated reality: the Slab template computes to **99 working days**, 51 critical tasks (42 force_critical + 9 CPM-discovered). The restructured engine MUST reproduce this exactly on the same data. Use it as a regression checkpoint.

### 2.7 Stage codes & gates (preserve exactly — separate from scheduling)
- Stage codes (0.3–9.5) are REPORTING labels, computed from which trigger-tasks are finished. Separate from phases and from the schedule engine, but the module should expose a `computeStage(tasks, gateState)` that reproduces current behavior.
- Utility GATES (gas/power/water) can CAP the reported stage at 5.9 while the true stage advances. Gates are OPTIONAL per template. "Cap-and-snap at 5.9" behavior must be preserved.
- Action-type tasks: note that #142 triggers stage 9 and #145 triggers stage 9.5. If any "actions don't trigger stages" rule is added, it MUST exempt stage-trigger tasks. (Currently actions DO trigger where mapped.)

---

## 3. THE INTEGRITY RULES (build into the shared module; enforce in template builder)

These are Collin's core scheduling principles. They live in the shared module as `validateSchedule(tasks)` so the template builder AND runtime enforce identical logic.

1. **Every task must have at least one predecessor.** No task may float free on a fixed date. The ONLY exception is the single designated project-start task (e.g. Silt Fence), which anchors to the construction start date.
   - Rationale: a task with no predecessor sits frozen and never moves when the schedule shifts, throwing everything out of sequence.
2. **A task need NOT have a successor.** Terminal tasks are fine.
3. **Negative lag (lead time) requires its driving predecessor to already exist at save time.** You cannot save a task with a negative-lag link to a task that doesn't exist yet. (Build the real work chain first, then hang procurement tasks backward off it.) Enforce as a HARD BLOCK in the template builder + a validator that flags existing violations.
4. **Order/procurement tasks are modeled via negative lag**, not a separate field. "Order Cabinets" has predecessor "Install Cabinets" with lag −15 (starts 15 WD before install starts). This makes order tasks non-floating — they satisfy rule #1 through their install task.

`validateSchedule` should return a list of violations (task, rule broken, human message) so the UI can show them and block save where required.

---

## 4. DATA / SCHEMA (preserve; add relationship support)

**Backend:** ONE Supabase project, ref `acodbcpmxridiwlufkez`, shared by dev and live.

**Dev/live isolation is by TABLE-NAME PREFIX, not separate DBs:** `supabase.js` reads `const TABLE_PREFIX = process.env.TABLE_PREFIX || ''` and prepends it to every table name. Dev Netlify site sets `TABLE_PREFIX=dev_`; the LIVE site leaves it EMPTY. The literal `dev_` never appears in code. **NEVER put `dev_` in the live site's env.** After ANY change to supabase.js, run the twofold isolation test: (1) a dev write lands in `dev_` tables; (2) live tables are untouched.

**All schema changes = `.sql` files committed to the repo, applied to BOTH prefixes.** Never schema-only in the dashboard.

**Tables (each has a `dev_` twin):**
`sched_lots, sched_lot_tasks, sched_lot_task_notes, sched_lot_gate_state, sched_subdivisions, sched_subdivision_lots, sched_subdivision_templates, sched_templates, sched_template_tasks, sched_template_phases, sched_template_gates, sched_template_stage_map, sched_stage_map_tasks, sched_companies, sched_delay_reasons, sched_task_delays`
`field_ops_builders, field_ops_lots, field_ops_delays, field_ops_overrides, field_ops_submissions, field_ops_walk_notes`

**Task scheduling fields already present** on `sched_lot_tasks` and `sched_template_tasks`: `predecessors` (array), `lag`, `duration`, `relative_start`, `est_start_date`, `actual_start`, `actual_finish`, `status`, `is_critical`, `force_critical`, `task_type`, `trade`.
- **Negative lag needs NO new column** — reuse existing `lag` (negative = lead time). This is the agreed model.

**Supabase new-table checklist (all three or silent failure):** grant to `service_role`; grant to `anon`; `notify pgrst, 'reload schema'` + fresh deploy.

**Slab template:** id `9fae6f78-d2b5-4d57-9e09-8622d37cd829`, 129 tasks, ~19–20 phases, 99 working days.

**Reference file:** `ashland_stage_update_dev_code.txt` (provided) contains the full 129-task TASKS array with real predecessors/durations — use it to build the parity test fixture. NOTE: it reflects template defaults; live lots may have edited values, so ALSO test against a real lot pulled from the DB. Confirm currency with Collin.

**The 39 floating tasks:** 39 of 129 tasks currently have `predecessors: []` (mostly "Order X" / "X Delivery" / "Schedule X" actions, plus a few work items like Shutter/Gutter Install, Landscaping). These violate integrity rule #1. **Collin will personally assign the predecessor + (negative) lag for each** — these are real construction decisions, not to be guessed. The engine + builder must make it possible to set them (lag input already accepts negatives, min −99). Provide a clean way (validator report / list view) to see all violations so he can work through them.

---

## 5. WHAT ELSE MUST BE PRESERVED (don't drop features during restructure)

- PIN login + lockout (5 attempts), forced change on temp PIN, admin unlock.
- Delay-reason capture: mandatory modal when a CRITICAL task finishes late; 8 reasons; "Other" requires a note; fail-safe (if reasons can't load, finish still proceeds); bulk push inherits source lot's reason with `source_lot_id`.
- Per-task notes: permanent historical data, timestamped + signed. **NEVER expose a delete-note control anywhere, for anyone.** Builders can add/flag only.
- Work/action classification and the 3-way phase filter (All / On site / To-dos).
- Icon legend, bulk lot entry, admin phase modal showing computed dates with confirmed/scheduled/override chips.
- Export (CSV) with ISO dates + filter mirroring.
- Bulk push (push a task update to other lots).
- Admin structure: Lots / Delays / Settings (Builders, Subdivisions & Companies, Delay Reasons, Schedule Templates).

---

## 6. FILE / DEPLOY RULES (hard-won — violating these breaks live)

- **Live files (main branch):** `ashland-stage-update.html`, `admin.html` — never suffixed.
- **Dev files (Dev branch):** `ashland-stage-update-dev.html`, `admin-dev.html` — carry a red DEV banner; strip it for live.
- **GitHub:** `AshlandHomes/Ashland-Field-App`, `main` = live, `Dev` = dev.
- **Netlify:** live site `ashland-field-ops`, dev site `ashland-field-ops-dev`. Function changes require **"Clear cache and deploy site."** Env var "Contains secret values" must stay UNCHECKED.
- **Browser HTTP cache** (no service worker exists) serves stale HTML/CSS after deploy → "Failed to fetch" on load / unstyled elements. Mitigation to BUILD IN during restructure: **cache-busting** (e.g. versioned `?v=` query on script/style includes) so builders auto-get fresh files. This is currently a real pain point — solve it as part of the restructure.
- **One fix at a time; verify each before the next.** Do not batch changes.
- **Duplicate function names / duplicate switch-cases silently shadow.** This has bitten the project twice (a duplicate `wdBetween`, and duplicate switch-cases in supabase.js). The single-module design largely eliminates this — keep it that way.

---

## 7. MIGRATION / CUTOVER PLAN (behavior parity is the gate)

1. **Branch:** do all work on `Dev`. Never touch `main` until parity passes.
2. **Build the shared module** `schedule-engine.js` + wire all callers + delete inline engines.
3. **Parity harness (the acceptance test):** a script that loads the real 129-task Slab data (and at least one real live lot pulled from Supabase), runs BOTH the OLD behavior and the NEW module, and asserts identical `es/ef` for every task across scenarios: clean schedule; a started task; a finished task; an est_start_date override; a negative-lag order task; an upstream override cascading downstream; the 99-day / 51-critical regression check. Must be 100% identical (except where the OLD engines were provably wrong and we intend to fix — document any such case explicitly and get Collin's sign-off).
4. **Deploy to dev**, run the twofold isolation test, and have Collin validate on the dev field app + dev admin (dates identical between them — that's the whole point).
5. **Data migration:** schema is preserved, so this is minimal. If any new columns/constraints are added, provide `.sql` for both prefixes and a migration that back-fills live data into the new format with ZERO behavior change.
6. **Live cutover:** promote to `main`. Because behavior is identical, **builders feel nothing.** Keep the live site's `TABLE_PREFIX` empty. Run the isolation test again post-deploy.
7. **Relaunch UAT** on the new architecture for proper testing (negative lag, integrity rules, template builder).

**Do not cut over on anything less than green parity on real data.**

---

## 8. SEQUENCING (what to build, in order)

1. Extract + prove the shared `schedule-engine.js` (pure, UMD, tested against real data). **Engine correctness first, in isolation.**
2. Wire field app, admin, backend to import it; delete the three inline copies.
3. Parity harness green → deploy dev → Collin validates dates match across surfaces.
4. Cache-busting for deploys.
5. `validateSchedule` integrity rules + template-builder enforcement (hard blocks; can't-save-negative-before-driver; violation report for the 39 floating tasks).
6. Collin assigns predecessors/negative-lags to the 39 (his decisions; you make it possible + validate).
7. Live cutover with parity green. Relaunch UAT.

**Deferred (note, don't build):** hard-pin overrides + conflict flags; the ERP platform shell (separate project); pulling a date earlier than computed.

---

## 9. FIRST ACTIONS FOR CLAUDE CODE

1. Confirm you've read and understood this spec; restate the prime goal (one shared engine, behavior parity as the gate, no big-bang rewrite) in your own words.
2. Inventory the repo; locate the three current engine implementations (field app `runEngine` in `ashland-stage-update.html`, backend `calcEF`/getAllLotPhases in `netlify/functions/supabase.js`, and any admin copy).
3. Propose the `schedule-engine.js` module interface (function signatures + return shapes) and the parity-harness plan. **Wait for Collin's approval before implementing.**
4. Then build incrementally, proving each step against real data. One change at a time.
