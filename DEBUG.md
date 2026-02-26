# DEBUG Runbook (Verified)

Verified on: `2026-02-23`
Repo: `repo_hydra_audit`

This file contains only methods that were executed and observed in this workspace.

## Runtime: Node/TypeScript app (`dist/index.js`)

### 1) Type-check and build

Command:

```bash
npm run check
npm run build
```

Observed output:

- `tsc -p tsconfig.json --noEmit` completed with exit code `0`.
- `tsc -p tsconfig.json` completed with exit code `0`.

### 2) Start -> probe -> stop (single-command verifier)

Command:

```bash
node debug/verify-runtime-loop.mjs
```

Observed output (from the command JSON):

- `healthProbe.ready: true`
- `healthProbe.afterMs: 3446`
- `/health` returned `status: ok`
- `/runtime/status` returned `stage: paper`
- `/backtest/run` returned HTTP `200` with metrics (`netPnl`, `profitFactor`, `sharpe`)
- shutdown used `SIGTERM` (`signalCode: "SIGTERM"`)

### 3) Programmatic state-driving methods (verified)

Inside `debug/verify-runtime-loop.mjs`, these API calls were executed successfully:

- `GET /health`
- `GET /runtime/status`
- `GET /backtest/status`
- `POST /backtest/run`
- `GET /ml/registry`
- `GET /rl/status`

All returned HTTP `200` in the same run.

### 4) Logging visibility (verified)

Command:

```bash
node scripts/smoke.mjs
```

Observed output included structured runtime logs:

- `scope: "hydra:market-feed"` (`mock market feed started`)
- `scope: "hydra:backtest"` (`backtest run completed`)
- `scope: "hydra:api"` (`api server started`)
- `scope: "hydra"` (`runtime started`)

### 5) Eval/REPL path (verified)

Command:

```bash
node -p process.version
```

Observed output:

- `v22.13.1`

## Runtime: Detached training loop (`train-until-target`)

### 1) Start detached trainer

Command:

```bash
node scripts/start-train-bg.mjs debug/train-bg-test.log 3 0 0 0
```

Observed output:

- PID printed: `6744`

### 2) Inspect iterations from log

Command:

```bash
node scripts/last-train-iterations.mjs debug/train-bg-test.log 10
```

Observed output:

- `totalTrainIterations: 3`
- Iteration 1 promoted (`winRate: "100.00%"`, `netPnl: "5.42"`)
- Iterations 2-3 present and parsed

### 3) Scan important training events

Command:

```bash
node scripts/inspect-train-log.mjs debug/train-bg-test.log 120
```

Observed output included:

- `supervised retrain completed`
- `rl retrain completed`
- `train iteration` rows

## Supporting validation commands (verified)

```bash
node -v
npm -v
docker --version
docker compose version
docker compose config
```

Observed:

- Node `v22.13.1`
- npm `11.1.0`
- Docker CLI present (`28.0.4`)
- Compose plugin present (`v2.34.0-desktop.1`)
- Compose file parses successfully (`docker compose config` exit code `0`)

## Not verified / failed in this environment

These were executed and failed, so they are not usable as a trusted loop here:

- `node scripts/index-smoke.mjs` -> `TypeError: fetch failed` (startup wait too short).
- `node scripts/e2e-bcd.mjs` -> `TypeError: fetch failed` (startup wait too short).
- `docker compose up -d --build` -> Docker engine pipe unavailable:
  - `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`

## Verified helper scripts added

- `debug/verify-runtime-loop.mjs`
  - Robust start/probe/shutdown loop with health polling.
  - Designed to provide concise JSON evidence.
