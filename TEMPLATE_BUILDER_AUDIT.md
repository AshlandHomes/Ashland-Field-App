# Schedule Template Builder — full audit & gap analysis (Dev, investigation only)

Audited `admin-dev.html` (builder UI), `netlify/functions/supabase.js` (endpoints +
data model), `schedule-engine.js` (validation). No code changed.

**Headline:** stages and gates are ALREADY fully modeled in the DB and wired for
read / stamp-to-lot / clone / delete. What's missing is mostly **builder UI + create-edit
endpoints + explicit opt-flags + real validation** — not new data plumbing.

## 1. What the builder CAN do today
- **Templates:** create (blank), **clone** (copies tasks, phases, stages, gates — full),
  rename, archive, delete.
- **Phases:** add / edit / delete (name, phase_order).
- **Tasks:** add / edit / delete with `bt_num`, name, phase, `duration`, `lag`,
  `predecessors` (picker), `relative_start` / `relative_finish`, `task_order`,
  `task_type` (only **work | action**), `trade`. `is_critical` is auto-computed
  (`recalcTemplateCriticalPath` after every task change).
- **Dependents view** (`computeSuccessors`); **soft warnings** on save/delete/renumber:
  self-orphan (task with no predecessor), renumber-dangle, delete-orphan. All are
  confirm-dialogs — none BLOCK.

## 2. Gaps — each classified (data-model vs UI vs logic)

### A. STAGE-TRACKING config (task→stage map)  — **UI + write-endpoint gap**
- **Data model EXISTS:** `sched_template_stage_map` (`stage_code`, `stage_label`,
  `is_manual`, `stage_order`) + `sched_stage_map_tasks` (`stage_map_id` → `task_id`, the
  trigger tasks). Read path `getTemplateStageMap` exists; `cloneTemplate` copies it;
  `deleteTemplate`/`deleteTemplateTask` cascade-delete it.
- **MISSING:** (a) any **create/edit endpoint** (only get/delete/clone — no
  `upsertTemplateStage` or stage↔task link write); (b) **builder UI** entirely.
- **Consequence:** a NEW blank template has 0 stages → its lots get `reported_stage=null`
  → admin Stage column shows a muted `—` (see F/opt-out). Stages today exist ONLY via
  clone or raw SQL.

### B. GATES config (utility/other gates)  — **UI + write-endpoint gap**
- **Data model EXISTS:** `sched_template_gates` (`name`, `icon`, `hold_stage_code`,
  `gate_order`, `template_id`). `stampLot` copies them into `sched_lot_gate_state` per
  lot; clone copies; delete cascades; there's even a re-stamp/backfill path.
- **MISSING:** (a) any **create/edit endpoint** (only get/delete/clone/stamp); (b)
  **builder UI** entirely — including `hold_stage_code` (which stage a gate holds at) and
  `icon`.
- **Field-app behavior with 0 gates:** the lot-header gate section already collapses
  (`if(lotGates.length){…}`), so **Collin's requirement #2 display is already met** when
  gates are absent. Gates today exist ONLY via clone or SQL.

### C. Explicit OPT-IN / OPT-OUT flags  — **DATA-MODEL gap**
- **No** `stages_enabled` / `gates_enabled` (or equiv) column on `sched_templates`.
  Opt-out today is **implicit** — "no stage rows" / "no gate rows."
- Needs: (a) explicit flag columns (data-model), (b) builder toggle (UI), (c) admin
  **"N/A"** rendering for an opted-out template's lots — today `stageCell` shows a muted
  `—`, which is **ambiguous** with "not yet computed," not an explicit "N/A."

### D. DEAD-END / reachability validation (the ~37-dead-end problem)  — **logic + designation + UI gap**
- `ScheduleEngine.validateSchedule` EXISTS but only covers **Rule 1** (every task has ≥1
  predecessor except a designated start task) and **Rule 3** (neg-lag driver exists).
  **There is NO Rule 2 reachability check** — nothing verifies every task can reach the
  terminal/Closing task. (The rule numbering literally skips 2.)
- `validateSchedule` needs a `startTaskNum`, but **no start/terminal task is designated
  or stored** anywhere.
- `validateSchedule` is **not called by the builder at all** — it's unused.
- Classification: reachability = **missing logic**; start/terminal task = **data-model
  (designation)**; surfacing = **UI**. The DB can store any graph — the gap is the
  validator + the designation + wiring it into save.

### E. "Every task has a predecessor" enforcement  — **logic + UI gap**
- Only the SOFT self-orphan confirm on save; never blocks, and there's no template-level
  audit ("these N tasks have no predecessor") nor a "single start task" model. `startTaskNum`
  has no home, so even Rule 1 can't run correctly.

### F. Other things a complete template needs but can't express
- **Task types capped at work|action** — the field app renders icons for more kinds
  (📋 action / 🔨 work), but the builder can't set anything else. `task_type` is a free
  string in the DB → **UI-only gap** if we want more types.
- **Manual vs task-driven stage** (`is_manual`) not configurable — part of the stage UI gap.
- **Gate hold-stage** (`hold_stage_code`) not configurable — part of the gate UI gap.
- **Per-task "requires vendor confirmation"** not expressible — the field app has
  `vendor_confirmed` (per-lot state) but the template can't mark which tasks need it →
  **data-model + UI** if wanted.
- **`relative_start`/`relative_finish`** are exposed but overlap with predecessor-driven
  scheduling — no guardrail/explanation → **UI clarity** risk.
- **No uniqueness/consistency checks** (duplicate `bt_num`, gaps in `task_order`).

## 3. Cross-cutting requirements to bake into the design
1. **Opt-outs must NOT break push.** Push (`_bpApply`) computes the target's stage from
   its stage map: empty map → `sm=[]` → `trueStage=null` → `reportedCode=null` → writes
   null; empty gates → `gates.some(!confirmed)=false`. It LOOKS graceful, but it is
   **untested** for opt-out. Design must add tests: push from a no-stage template (pushes
   the task actuals, skips the stage cleanly) and from a no-gate template (doesn't choke
   on missing gates).
2. **Existing live templates/lots default to current behavior.** The new opt-flags must
   DEFAULT to "enabled." Because today's templates HAVE stage/gate rows, "default enabled"
   preserves current behavior — no live lot flips to N/A-stage or collapsed-gates. Opting
   out is a deliberate choice on a NEW template.
3. **Testable for push correctness, incl. opt-out cases** — a new template + its lots must
   be drivable through the push tests (stages-on, stages-off, gates-on, gates-off).

## 4. One-line gap ledger (for prioritization)
| Gap | data-model | backend write | builder UI | logic |
|---|---|---|---|---|
| A. Stage map config | ✅ exists | ❌ missing | ❌ missing | — |
| B. Gates config | ✅ exists | ❌ missing | ❌ missing | — |
| C. Opt-in/out flags | ❌ add flags | ❌ (with flags) | ❌ toggle | ❌ N/A render |
| D. Reachability / dead-end | ✅ (graph) | — | ❌ surface | ❌ Rule 2 + terminal |
| E. Predecessor enforcement | ➕ start-task designation | — | ❌ | ❌ hard/audit |
| F. Task types / vendor-req / rs-rf | mixed | mixed | ❌ | — |
