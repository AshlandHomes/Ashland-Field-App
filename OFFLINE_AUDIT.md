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

## 5. PRIORITY — the SILENT failures (lose field data with no warning) — ALL RESOLVED
1. ✅ **`addTaskDelay` — delay reason on a late-task finish.** Routed as an ordered pair with
   the finish (`f4c8ffd`). Proof: `test/offline-delay-browser.js`.
2. ✅ **`cycleNoteFlag` — note flag.** Routed + client-id reconciliation for offline-created
   notes (`ecd8602`). Proof: `test/offline-flag-browser.js`.
3. ✅ **`toggleConfirm` — vendor confirmed.** Routed as a partial write (`c474c97`). Proof:
   `test/offline-confirm-browser.js`.
4. ✅ **`saveEditTask` — task edit.** Routed as an ordered pair; also fixes the stuck-"Saving…"
   hang (`8dd4c82`). Proof: `test/offline-edit-browser.js`.

(#1–#3 also lost data on a transient ONLINE blip — a network throw with no retry — so routing
them through the durable queue hardened the online path too.)

## GUARDRAIL against bug #5 — `test/offline-write-guard.js`
Static source scan: FAILS if any of the seven queued-write actions
(`updateScheduleLotTask`, `addTaskNote`, `respondNoteResolution`, `updateScheduleLotGate`,
`addTaskDelay`, `updateTaskNote`, `editLotTask`) is called via a direct `sbCall`/`sbCallRaw`
literal OUTSIDE the sanctioned zones (`drainQueue`, and `_bpApply`/`_bpApplyNote` = bulk push /
KI-13). Green today; goes red the moment a new direct queued-write is added — verified by
injecting a rogue call. This is what makes a fifth silent-loss write impossible to merge unnoticed.

Every simple builder write now goes through the ONE durable path (queueAndSync). Only the
drain (the sanctioned executor) and bulk push (KI-13, replay-with-reads) still call sbCall for
writes directly.
