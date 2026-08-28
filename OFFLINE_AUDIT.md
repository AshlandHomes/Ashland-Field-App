# Offline failure-mode audit — field app (investigation, 2026-08-28)

Every server touch in `ashland-stage-update-dev.html`, classified by what happens with
NO signal. Flags: ✅ covered offline · ⚠️ fails VISIBLY (builder is told/sees it) ·
🔴 FAILS SILENTLY (data lost, looks like it worked — the addTaskDelay class).

Key mechanic: `sbCallRaw` THROWS on a network failure. `sbCall` only catches a *server*
`{error}` (reachable backend) → the network throw propagates to the caller. So a direct
`await sbCall(write)` with no try/catch, after an optimistic UI update, = silent loss.
And because it's a network throw, these also lose data on a transient ONLINE blip.

## 1. WRITES
| Write (fn) | Endpoint | Path | Offline result | Flag |
|---|---|---|---|---|
| start/finish/undo (`saveTask`) | updateScheduleLotTask | **queue** | queues, drains on reconnect | ✅ |
| note add (`addNote`) | addTaskNote | **queue** | queues | ✅ |
| flag response (`checkPendingResolutions`) | respondNoteResolution | **queue** | queues | ✅ |
| gate toggle (`toggleGate`) | updateScheduleLotGate | **queue** | queues (new) | ✅ |
| **delay reason on finish (`finishTask`)** | addTaskDelay | direct, in try/catch | reason DROPPED (`console.warn` only) | 🔴 SILENT |
| **vendor confirm (`toggleConfirm`)** | updateScheduleLotTask(vendor_confirmed) | direct, NO try/catch, optimistic `renderTasks()` | UI shows ✓ confirmed, write lost, no error | 🔴 SILENT |
| **note flag cycle (`cycleNoteFlag`)** | updateTaskNote(flag) | direct, NO try/catch, optimistic `renderThread()` | UI shows new flag, write lost, no error | 🔴 SILENT |
| **task edit (`saveEditTask`)** | editLotTask + updateScheduleLotTask | direct, NO try/catch, in-memory mutated first | button stuck "Saving…", modal stays open (semi-visible); DB write lost | 🔴/⚠️ MIXED |
| forced PIN change (`setPinKey`) | setBuilderPin | direct | unreachable offline (offline login uses local hash) | N/A online-only |
| bulk push (`_bpApply`/`_bpApplyNote`) | bulkUpdateLotTasks / addTaskNote / addTaskDelay | direct, per-lot try/catch | every lot fails → shown in summary "0 of N ✗" | ⚠️ VISIBLE (KI-13) |

## 2. READS
| Read | Path | Offline result | Flag |
|---|---|---|---|
| getBuilders, getScheduleLots, getScheduleLotTasks, getTemplateStageMap, getTaskNotes, getDelayReasons | **sbRead (cache)** | served from last-online cache (territory prefetch fills it) | ✅ |
| verifyPin | direct, but only in the `_isOnline` branch | offline path uses `verifyPinOffline` (local hash) | ✅ |
| getPendingResolutions (app-open) | direct, in try/catch → `return` | resolution modal just doesn't appear; re-offered next online open; no data lost | ⚠️ degraded-safe |
| bulk push reads (getScheduleLotTasks, getTemplateStageMap, getDelaysForTask) | direct | fail → per-lot failure in the push summary | ⚠️ VISIBLE (KI-13) |

## 3. SIDE-EFFECTS / derived-after-action (the sneaky ones)
| Side-effect | Fires after | Offline result | Flag |
|---|---|---|---|
| `saveStage` (reported_stage) | task/gate change | NOT inline anymore — recomputed post-drain only (`recomputeDerivedAfterSync`, online, guarded); derived value lags, actual is durable | ✅ (accepted edge) |
| `checkCompletionStamp` | finishing last task | post-drain only, guarded | ✅ |
| **`addTaskDelay`** | a LATE-task finish | the finish (`saveTask`) queues durably, but this SEPARATE direct write silently drops → **main action survives, side-effect vanishes** | 🔴 SILENT (#1) |

## 4. ASSUMES CONNECTIVITY
| Feature | Offline result | Flag |
|---|---|---|
| AI note cleanup (`aiCleanup`, `/cleanup`) | `catch → alert('Cleanup error')`; raw note text stays in the box | ⚠️ VISIBLE, no loss |
| bulk push | no "you're offline" pre-check — tries and every lot fails in the summary | ⚠️ VISIBLE, no loss (KI-13) |
| on-open resolution prompt | silently skipped, re-offered next online | ⚠️ degraded-safe |
| `probeConnectivity` / `loadSecret` fetches | fail fast (reject), no hang | ✅ |
| _No infinite spinners found._ | | ✅ |

## 5. PRIORITY — the SILENT failures (lose field data with no warning)
1. 🔴 **`addTaskDelay` — delay reason on a late-task finish.** Finish survives (queued), reason
   vanishes. Data-integrity gap on a CORE offline action. **Highest.**
2. 🔴 **`toggleConfirm` — vendor confirmed.** UI actively shows ✓, write lost, no error. A
   builder confirming a vendor/utility in the field believes it saved. **High.**
3. 🔴 **`cycleNoteFlag` — note flag (red/yellow).** UI shows the flag, write lost. Flags drive
   the admin red-flag resolution loop, so a lost flag = a missed escalation. **Medium-high.**
4. 🔴/⚠️ **`saveEditTask` — task edit.** Semi-visible (button hangs) but DB write silently lost;
   in-memory edit misleads. Planning action, LOW field need. **Low.**

Note: #1–#3 also lose data on a transient ONLINE network blip (network throw, no retry),
not only in full offline — so the fix (route through the durable queue) helps online too.

Fixes NOT applied — audit only. Fix order is Collin's call.
