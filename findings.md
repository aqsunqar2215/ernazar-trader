# Findings & Decisions

## Key Findings (Phase 4)

1. **Compile blockers устранены**
- `src/core/types.ts`: `AuditEvent.type` расширен значением `rl_execution_guard_blocked`.
- `src/ml/ml-service.ts`: в RL retrain правильно подключён `ensembleGate` перед `evaluatePromotion`.

2. **Статические проверки зелёные**
- `npm run -s check` — pass
- `npm run -s build` — pass
- `npm run -s test:multisymbol` — pass

3. **Shadow gate и paper sanity работают через runtime как primary source**
- `debug/run-shadow-until-trades.mjs` использует:
  - runtime `shadowGate` как основной gate (`gate = runtimeShadowGate ?? localGate`)
  - runtime `paperSanity` как основной sanity (`paperSanity = runtimePaperSanity ?? localPaperSanity`)
- Подтверждено артефактом: `debug/dynamic-target-existing.log` и `debug/shadow-report-exec-guard-quick.json`.

4. **Dynamic target/gate timeout от runtime gate подтверждены**
- В `debug/dynamic-target-existing.log`:
  - `targetTrades = 500` (из `runtime.shadowGate.tier`)
  - `gateTimeoutMs = 86400000` (из `runtime.shadowGate.limits.timeoutMs`)

5. **Execution-time guard enforcement подтверждён**
- `debug/execution-guard-check.json`:
  - `blockedEvents = 49` по типу `rl_execution_guard_blocked`
  - `guardBlocks.total = 159`
- Значит блокировки фиксируются и в runtime audit, и в RL status counters.

6. **Regime split logging подтверждён при включённом флаге**
- `debug/regime-check.log` содержит `rlRegimeStats` при `RL_REGIME_SPLIT_ENABLED=true`.

7. **OOS prefilter подтверждён на retrain**
- `debug/oos-prefilter-check.json`:
  - `oosPrefilter.passed = false`
  - retrain прерван для supervised и RL с причиной `insufficient oos candles per symbol`.

8. **Ensemble gate подтверждён**
- `debug/ensemble-gate-check.json`:
  - `ensembleGate.passed = false`
  - `rlPromoted = false`
  - reason: `ensemble median OOS profit factor below threshold (...)`.

9. **Execution costs consistency подтверждена**
- `computeExecutionCosts` используется в:
  - `src/backtest/engine.ts`
  - `src/ml/rl-trainer.ts`
  - `src/ml/rl-shadow-simulator.ts`
  - `src/execution/paper-broker.ts`

10. **По smoke-конфигам**
- Индекс 1 (tuned): `debug/smoke-index1-tuned.log` → `gateReason=pass` (готов к продвижению).
- Индекс 2 (tuned-v2): `debug/smoke-index2-tuned-v2.log` → `gateReason=kpi_fail` (нужен следующий тюнинг).

## Decisions

1. **Phase 3 считать завершённой**
- Реальные кодовые фиксы сделаны, сборка и проверки проходят.

2. **Phase 4 считать закрытой**
- Checklist из запроса покрыт запуском/артефактами + проверкой кода.

3. **Сфокусироваться на rollout решении**
- Продвигать индекс 1.
- Для индекса 2 делать отдельный цикл параметрического тюнинга.

## Open Risks / Follow-ups

1. Закрыто 2026-03-01: runtime cleanup-pass внедрён и выполнен (см. `debug/runtime-cleanup-kill.json`).
2. Закрыто 2026-03-01: index2 smoke `kpi_fail` закрыт успешным tuned-v3 прогоном (см. `debug/shadow-report-index2-tuned-v3.json`).

## Rerun Notes (2026-03-01)

1. **Повторно прогнаны базовые проверки**
- `npm run -s check` — pass
- `npm run -s build` — pass
- `npm run -s test:multisymbol` — pass

2. **Повторно проверен runtime-shadow отчёт**
- Артефакт: `debug/shadow-report-phase4-rerun.json`
- Подтверждено наличие runtime-данных в отчёте: `gate`, `paperSanity`, `finalSnapshots.runtimeStatus`.

3. **По динамическим значениям target/gate timeout опора остаётся на стабильный артефакт**
- Подтверждение по `debug/dynamic-target-existing.log`:
  - `targetTrades = 500`
  - `gateTimeoutMs = 86400000`

4. **Execution-time/OOS/Ensemble rerun на новых портах местами нестабилен операционно**
- В ряде isolated rerun-попыток были `runtime_not_ready`/нестабильный локальный runtime lifecycle.
- Для acceptance использованы стабильные ранее полученные артефакты:
  - `debug/execution-guard-check.json`
  - `debug/oos-prefilter-check.json`
  - `debug/ensemble-gate-check.json`

## Open Items Closure (2026-03-01)

1. **Операционный cleanup runtime закрыт**
- Добавлен инструмент: `debug/cleanup_runtime_ports.py` (dry-run + kill mode).
- Подтверждён cleanup stale runtime:
  - до: `debug/runtime-cleanup-before.json`
  - kill-pass: `debug/runtime-cleanup-kill.json` (terminated PID 23164 on port 8101)
  - после: `debug/runtime-ports-after-cleanup.json` (`[]` в диапазоне 8090-8120)

2. **Добавлен детерминированный isolated runtime профиль**
- Добавлен runner: `debug/run-shadow-isolated.mjs`.
- Каждый прогон использует isolated `PORT` + isolated `DB_PATH`, пишет metadata в `debug/runtime-profile-*.json`.
- Loop-верификация:
  - `debug/verify-runtime-isolated-8611.json`
  - `debug/verify-runtime-isolated-8612.json`
  - оба: `runtimeMode=spawned`, `healthProbe.ready=true`.

3. **Index2 smoke закрыт успешным tuned прогоном**
- Артефакты:
  - `debug/smoke-index2-tuned-v3.log`
  - `debug/shadow-report-index2-tuned-v3.json`
  - `debug/runtime-profile-index2-tuned-v3.json`
- Результат:
  - `overallPassed=true`
  - `reachedTarget=true`
  - `rlTrades=100`
  - `tradesPerMinute=3.838`
  - `profitFactor=2.4396`
  - `netPnlUsd=64.103`

4. **Root cause зафиксирован**
- Причина нестабильных падений из предыдущих rerun: `database is locked` при shared sqlite (`DB_PATH`).
- Mitigation: isolated DB per run (уникальный `DB_PATH`), что устранено в `run-shadow-isolated.mjs`.
