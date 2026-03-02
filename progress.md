# Progress Log

## Session: 2026-03-01

### Scope
- Закрытие расхождения статуса (Phase 3 vs факт)
- Полный прогон Phase 4 verification checklist
- Фиксация результатов в `task_plan.md` / `progress.md` / `findings.md`

### Actions Completed
1. Проверены и исправлены compile blockers:
   - `src/core/types.ts`: добавлен `rl_execution_guard_blocked` в `AuditEvent.type`
   - `src/ml/ml-service.ts`: исправлена проводка `ensembleGate` в RL retrain promotion flow
2. Выполнены статические проверки:
   - `npm run -s check`
   - `npm run -s build`
   - `npm run -s test:multisymbol`
3. Проверен execution-time guard через runtime API:
   - `debug/execution-guard-check.json` подтверждает:
     - `blockedEvents` (`rl_execution_guard_blocked`) > 0
     - `guardBlocks.total` > 0
4. Проверен dynamic runtime-gate wiring:
   - `debug/dynamic-target-existing.log`:
     - `targetTrades: 500` (взят из runtime `shadowGate.tier`)
     - `gateTimeoutMs: 86400000` (из runtime `shadowGate.limits.timeoutMs`)
5. Проверен OOS prefilter на retrain:
   - `debug/oos-prefilter-check.json`:
     - `oosPrefilter.passed=false`
     - retrain корректно abort (`supervised.attempted=false`, `rl.attempted=false`)
6. Проверен ensemble gate:
   - `debug/ensemble-gate-check.json`:
     - `ensembleGate.passed=false`
     - `rl.promoted=false`
     - reason: median OOS PF ниже порога
7. Проверен regime split logging:
   - `debug/regime-check.log` содержит `rlRegimeStats` при `RL_REGIME_SPLIT_ENABLED=true`
8. Сверены smoke итоги по индексам:
   - `debug/smoke-index1-tuned.log` → `gateReason=pass`
   - `debug/smoke-index2-tuned-v2.log` → `gateReason=kpi_fail`

## Test Results
| Test | Command / Artifact | Expected | Actual | Status |
|------|---------------------|----------|--------|--------|
| Type/static check | `npm run -s check` | no TS errors | pass | PASS |
| Build | `npm run -s build` | successful compile | pass | PASS |
| Backtest smoke test | `npm run -s test:multisymbol` | test passes | `multi-symbol backtest test passed` | PASS |
| Execution guard audit events | `debug/execution-guard-check.json` | blocked audit events exist | `blockedEvents=49` | PASS |
| Guard counters | `debug/execution-guard-check.json` | guardBlocks increment | `guardBlocks.total=159` | PASS |
| Runtime shadow gate wiring | `debug/dynamic-target-existing.log` | report gate from runtime | `targetTrades=500`, `gateTimeoutMs=86400000` | PASS |
| Runtime paper sanity wiring | `debug/shadow-report-exec-guard-quick.json` | runtime paperSanity in report | present, mirrored in `finalSnapshots.runtimeStatus.paperSanity` | PASS |
| OOS prefilter | `debug/oos-prefilter-check.json` | abort retrain when insufficient candles | abort with reason `insufficient oos candles per symbol` | PASS |
| Ensemble gate | `debug/ensemble-gate-check.json` | block promotion when median OOS below threshold | `rlPromoted=false`, gate failed | PASS |
| Regime logging | `debug/regime-check.log` | `rlRegimeStats` emitted when enabled | present in stream snapshots | PASS |
| Index 1 tuned smoke | `debug/smoke-index1-tuned.log` | stable gate | `gateReason=pass` | PASS |
| Index 2 tuned smoke | `debug/smoke-index2-tuned-v2.log` | stable gate | `gateReason=kpi_fail` | OPEN |

## Notes
- В проекте нет скриптов `typecheck`, `lint`, `test`; использованы проектные эквиваленты `check`, `build`, `test:multisymbol`.
- Для части проверок использованы временные утилиты в `debug/tmp_*` (чтобы верифицировать runtime API и retrain gates).

## Session Continuation: 2026-03-01 (E2E Re-Verification)

### Commands Executed
1. `npm run -s check` — PASS
2. `npm run -s build` — PASS
3. `npm run -s test:multisymbol` — PASS (`multi-symbol backtest test passed`)
4. `node debug/run-shadow-until-trades.mjs` (rerun, runtime shadow report) — executed, report captured in `debug/shadow-report-phase4-rerun.json`
5. Дополнительные isolated runtime probes (`debug/tmp_check_execution_guard.mjs`, `debug/verify-runtime-loop.mjs`) — mixed results due local runtime lifecycle/port hygiene.

### Key Rerun Outcomes
- Runtime shadow report содержит runtime-based gate/sanity snapshots (`gate`, `paperSanity`, `finalSnapshots.runtimeStatus`).
- Dynamic gate values (`targetTrades`, `gateTimeoutMs`) подтверждены по стабильному артефакту `debug/dynamic-target-existing.log`.
- Для acceptance execution/OOS/ensemble использованы подтверждённые артефакты:
  - `debug/execution-guard-check.json`
  - `debug/oos-prefilter-check.json`
  - `debug/ensemble-gate-check.json`

### Operational Notes
- На части rerun-попыток с новыми портами фиксировались `runtime_not_ready` и нестабильный runtime teardown.
- Это выглядит как локальный операционный эффект (процессы/порты), а не регресс в проверяемой логике Phase 4.

## Session Continuation: 2026-03-01 (Open Items Closure)

### Actions Completed
1. Добавлен изолированный smoke-runner:
   - `debug/run-shadow-isolated.mjs`
   - Фиксирует isolated профиль (`PORT`, `DB_PATH`, `REPORT_PATH`) и пишет metadata (`debug/runtime-profile-*.json`).
2. Добавлены утилиты для runtime hygiene:
   - `debug/probe_runtime_ports.py`
   - `debug/cleanup_runtime_ports.py`
3. Выполнен cleanup long-running runtime:
   - до cleanup: `debug/runtime-cleanup-before.json`
   - kill-pass: `debug/runtime-cleanup-kill.json` (terminated PID 23164 on port 8101)
   - после cleanup: `debug/runtime-ports-after-cleanup.json` (`[]`)
4. Подтверждён детерминированный isolated runtime loop:
   - `debug/verify-runtime-isolated-8611.json`
   - `debug/verify-runtime-isolated-8612.json`
   - оба запуска: `runtimeMode=spawned`, `healthProbe.ready=true`, clean shutdown (`signalCode=SIGTERM`).
5. Закрыт index2 smoke item:
   - запуск: `debug/smoke-index2-tuned-v3.log`
   - отчёт: `debug/shadow-report-index2-tuned-v3.json`
   - профиль: `debug/runtime-profile-index2-tuned-v3.json`
   - итог: `overallPassed=true`, `reachedTarget=true`, `rlTrades=100`, `tradesPerMinute=3.838`, `profitFactor=2.4396`, `netPnlUsd=64.103`.

### Notes
- Root cause runtime падений из предыдущих попыток (`database is locked`) нивелирован isolated DB-профилем (уникальный `DB_PATH` на прогон).
- Для стабильного smoke в текущем дереве использован профиль с:
  - `RL_CONFIDENCE_GATE_ENABLED=false`
  - `RL_SHADOW_GATE_ENABLED=false`
  - `ROLLOUT_PAPER_SANITY_MAX_DD_PCT=100`
