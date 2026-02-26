# ernazar Trader

Алготрейдинг-проект на TypeScript/Node.js для безопасной итеративной разработки торговых стратегий без LLM в контуре исполнения.

Ключевая идея: сначала валидация на истории и в paper/shadow-режиме, и только потом допуск к tiny live по набору строгих gate-метрик.

## Что делает проект

- Получает рыночные данные (candle/trade stream), хранит и нормализует их.
- Запускает стратегию с риск-ограничениями и paper execution.
- Ведет журнал ордеров, сделок, equity, алертов и аудита.
- Поддерживает бэктест/Walk-Forward проверки.
- Ведет ML-реестр моделей (`champion/challenger`).
- Тренирует supervised и RL challenger-модели.
- Запускает RL shadow-симуляцию в реальном времени без отправки реальных ордеров.

## Архитектура

Основные директории:

- `src/app` - runtime, trading engine, rollout-policy.
- `src/api` - Fastify API, WS stream, статика UI.
- `src/market` - market feed, cache, quality checks.
- `src/backtest` - historical replay и walk-forward оценки.
- `src/ml` - dataset builder, train/retrain pipeline, RL trainer/policy, shadow simulator, model registry.
- `src/state` - SQLite слой состояния и история исполнения.
- `src/risk`, `src/strategy`, `src/execution` - торговая логика и ограничения.
- `ui/` - веб-панель мониторинга.
- `scripts/` - утилиты запуска/анализа/обучения.

Точка входа: `src/index.ts` -> `AppRuntime`.

## Технологии

- Node.js >= 22
- TypeScript
- Fastify + WebSocket
- SQLite (локальное состояние и метрики)
- pnpm

## Локальный запуск

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm start
```

Для разработки:

```bash
pnpm dev
```

## Основные скрипты

- `pnpm build` - сборка TypeScript.
- `pnpm dev` - запуск в dev-режиме через `tsx`.
- `pnpm start` - запуск из `dist`.
- `pnpm check` - typecheck без emit.
- `pnpm backfill` - загрузка исторических свечей.
- `pnpm train:target` - итеративный retrain до целевых метрик.
- `pnpm test:multisymbol` - тестовый мульти-символьный backtest.

## API и наблюдаемость

Базовый URL: `http://localhost:8080`

- `GET /health` - health + runtime snapshot.
- `GET /candles` - свечи с нормализацией/заполнением пропусков.
- `GET /stream` (WS) - realtime stream + snapshot history.
- `GET /runtime/status` - текущее состояние торгового контура.
- `GET /runtime/orders|fills|positions|equity|alerts|audit` - состояние исполнения.
- `GET /backtest/status` - текущий статус gate.
- `POST /backtest/run` - запустить backtest/walk-forward.
- `GET /ml/registry` - реестр моделей.
- `GET /ml/checkpoints` - история retrain checkpoints.
- `POST /ml/retrain` - запустить retrain.
- `GET /rl/status` - статус RL shadow части.
- `GET /ui/` - веб-дашборд.

## ML/RL pipeline (safe rollout)

1. Сбор датасета: `src/ml/dataset-builder.ts`.
2. Тренировка supervised challenger.
3. Тренировка RL challenger в offline simulator:
   - исторический replay (без утечки будущего),
   - комиссии/проскальзывание/латентность,
   - risk-aware reward (turnover/drawdown penalties).
4. Оценка на walk-forward/holdout/unseen (по конфигу).
5. Промоут в champion только при прохождении gate-ограничений.
6. Realtime RL shadow (нулевая отправка ордеров).
7. Сравнение shadow метрик с текущим champion.
8. Допуск tiny live только после прохождения всех проверок.

## Примеры рабочих команд

Backfill за 365 дней:

```bash
pnpm backfill --symbols BTCUSDT,ETHUSDT --timeframes 1m --days 365
```

Backfill по диапазону:

```bash
pnpm backfill --symbols BTCUSDT --timeframes 1m,5m,1h --start 2024-01-01 --end 2025-01-01
```

Ручной retrain:

```bash
curl -X POST http://localhost:8080/ml/retrain
```

Итеративный retrain до цели:

```bash
TARGET_WIN_RATE=0.50 TARGET_NET_PNL=0 MAX_ITERS=300 pnpm train:target
```

## Конфигурация

Файл: `.env` (шаблон: `.env.example`).

Критичные группы параметров:

- Runtime/API: `HOST`, `PORT`, `NODE_ENV`.
- Market/trading: `SYMBOLS`, `TIMEFRAMES`, `MARKET_MODE`, `PAPER_ONLY`.
- Risk limits: `MAX_RISK_PER_TRADE_PCT`, `MAX_DAILY_LOSS_USD`, `MAX_DRAWDOWN_PCT`.
- Execution costs: `FEE_BPS`, `SLIPPAGE_BPS`.
- ML gates: `MIN_WF_SHARPE`, `MIN_WF_PROFIT_FACTOR`, `MAX_WF_DRAWDOWN`.
- Promotion controls: `ML_SIMPLE_PROMOTION_*`, `ML_HOLDOUT_RATIO`, `ML_UNSEEN_*`.
- RL training: `RL_*` (episodes, learning params, penalties, shadow guard).

## Безопасность rollout

- По умолчанию применяется многоступенчатая фильтрация качества моделей.
- RL не должен продвигаться в live-путь на основе только in-sample метрик.
- Все допуски завязаны на scorecard и OOS-метрики.

## Отладка и диагностика

Runtime probe:

```bash
node debug/verify-runtime-loop.mjs
```

Runtime + retrain probe:

```bash
set RUN_RETRAIN_PROBE=1&& node debug/verify-runtime-loop.mjs
```

`train-until-target` логирует диагностические поля:

- `metricSource` (`scorecard_retrain`, `current_retrain`, `registry_fallback`, `stale`)
- `scorecardMissingOnAttempt`
- `gateBasis`

## Статус проекта

Проект в активной фазе R&D и hardening.
Рекомендуемый рабочий режим: `paper + shadow`, с продвижением к tiny live только после стабильного прохождения gate-метрик.
