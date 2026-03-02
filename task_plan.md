# Task Plan: RL Gating + Phase 4 Verification

## Goal
Закрыть verification по Phase 4: подтвердить execution-time guard/gates, OOS prefilter, ensemble gate, consistency execution costs и обновить статусные файлы (`task_plan.md`, `progress.md`, `findings.md`) по факту.

## Current Phase
Phase 5 (Delivery)

## Phases

### Phase 1: Requirements & Discovery
- [x] Сверить требования по Phase 4 checklist
- [x] Проверить текущее состояние кодовой базы и артефактов
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Составить план проверок (static + smoke + runtime API)
- [x] Определить, какие проверки подтверждаются кодом, какие — запуском
- **Status:** complete

### Phase 3: Implementation / Fixes
- [x] Исправить compile blockers:
  - `AuditEvent.type`: добавить `rl_execution_guard_blocked`
  - `ml-service`: корректно подключить `ensembleGate` в RL promotion flow
- [x] Подтвердить сборку после фиксов
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Static checks:
  - `npm run -s check`
  - `npm run -s build`
  - `npm run -s test:multisymbol`
- [x] Shadow/report gates:
  - runtime `shadowGate` как primary gate в smoke report
  - runtime `paperSanity` прокидывается в report
  - dynamic `targetTrades` / `gateTimeoutMs` от runtime gate
- [x] Execution-time enforcement:
  - `guardBlocks` растут при блокировках
  - в runtime audit есть `rl_execution_guard_blocked`
- [x] Regime split logging:
  - поле `rlRegimeStats` появляется при `RL_REGIME_SPLIT_ENABLED=true`
- [x] OOS prefilter:
  - retrain корректно стопается при недостатке свечей
- [x] Ensemble gate:
  - promotion блокируется при низком median OOS PF
- [x] Execution costs consistency:
  - `computeExecutionCosts` используется в backtest/rl/paper/shadow
- **Status:** complete

### Phase 5: Delivery
- [x] Обновить `task_plan.md`
- [x] Обновить `progress.md`
- [x] Обновить `findings.md`
- [x] Передать итоговый отчёт пользователю
- **Status:** complete

## Open Items (Closed 2026-03-01)
1. [x] Закрыт операционный cleanup хвост по long-running runtime процессам/портам.
   - Артефакты: `debug/runtime-cleanup-before.json`, `debug/runtime-cleanup-kill.json`, `debug/runtime-ports-after-cleanup.json`.
2. [x] Index2 доведён до успешного smoke в изолированном профиле.
   - Артефакты: `debug/smoke-index2-tuned-v3.log`, `debug/shadow-report-index2-tuned-v3.json`, `debug/runtime-profile-index2-tuned-v3.json`.
3. [x] Добавлен детерминированный clean runtime профиль для локальных rerun.
   - Скрипт: `debug/run-shadow-isolated.mjs` (isolated `PORT` + isolated `DB_PATH` + metadata).
   - Дополнительно подтверждён loop старт/останов: `debug/verify-runtime-isolated-8611.json`, `debug/verify-runtime-isolated-8612.json`.
