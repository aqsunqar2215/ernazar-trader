# DEBUG Runbook (Verified)

Verified on: `2026-03-01`
Repo: `repo_hydra_audit`

This file contains only methods that were executed and observed in this workspace.

## Runtime: Node/TypeScript app (`dist/index.js`)

### 1) Build (TypeScript -> dist)

Command:

```bash
pnpm build
```

Observed output:

- `tsc -p tsconfig.json` completed with exit code `0`.

### 2) Typecheck (no emit)

Command:

```bash
pnpm check
```

Observed output:

- `tsc -p tsconfig.json --noEmit` completed with exit code `0`.

### 3) Start -> probe -> stop (spawned runtime on isolated port)

Command:

```bash
set PORT=8611&& set BASE_URL=http://127.0.0.1:8611&& set USE_EXISTING_RUNTIME=0&& set FORCE_NEW_RUNTIME=1&& node debug/verify-runtime-loop.mjs
```

Observed output (from JSON):

- `runtimeMode: spawned`
- `startPid: 31572`
- `healthProbe.ready: true`
- `healthProbe.afterMs: 2193`
- `/health status: ok`
- `/backtest/run status: 200` with `netPnl: 60.88640354694871`, `profitFactor: 1.0984938503368036`, `sharpe: 10.754510074336068`
- shutdown `signalCode: SIGTERM`
- runtime logs visible (`stdoutLines: 5`, `stderrLines: 2`)

### 4) Probe an already-running runtime (no restart)

Command:

```bash
node debug/verify-runtime-loop.mjs
```

Observed output (from JSON):

- `runtimeMode: existing`
- `healthProbe.ready: true`
- `healthProbe.afterMs: 4`
- `/runtime/status stage: paper`
- `/backtest/run status: 200`

### 5) State-driving recipe (verified via probe)

The probe command in steps 3-4 executed these API calls successfully:

- `GET /health`
- `GET /runtime/status`
- `GET /backtest/status`
- `POST /backtest/run`
- `GET /ml/registry`
- `GET /rl/status`

### 6) Manual restart loop (no hot reload)

Verified iteration path:

- Stop: handled by `debug/verify-runtime-loop.mjs` via `SIGTERM`
- Start: re-run the same command from step 3

### 7) Eval/REPL (Node)

Command:

```bash
node -v
```

Observed output:

- `v22.13.1`
