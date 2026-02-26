import { spawn } from 'node:child_process';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS ?? '20000');
const RUN_RETRAIN_PROBE = (process.env.RUN_RETRAIN_PROBE ?? '0') === '1';
const USE_EXISTING_RUNTIME = (process.env.USE_EXISTING_RUNTIME ?? '1') !== '0';
const FORCE_NEW_RUNTIME = (process.env.FORCE_NEW_RUNTIME ?? '0') === '1';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const getJson = async path => {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
};

const postJson = async path => {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST' });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
};

const safeGetJson = async path => {
  try {
    return await getJson(path);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: String(error),
      },
    };
  }
};

const safePostJson = async path => {
  try {
    return await postJson(path);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: String(error),
      },
    };
  }
};

const summarizeProbe = (path, probe) => {
  const body = probe?.body ?? {};

  if (path === '/health') {
    return {
      status: body.status,
      service: body.service,
      uptimeMs: body.uptimeMs,
      backtestGate: body.backtestGate,
      wsClients: body.wsClients,
    };
  }

  if (path === '/runtime/status') {
    return {
      stage: body.stage,
      equityUsd: body.equityUsd,
      drawdownPct: body.drawdownPct,
      backtestGate: body.backtestGate,
      paperTrades: body.paperMetrics?.trades,
    };
  }

  if (path === '/backtest/status' || path === '/backtest/run') {
    return {
      passed: body.passed,
      reason: body.reason,
      netPnl: body.result?.backtest?.netPnl ?? body.backtest?.netPnl ?? null,
      profitFactor: body.result?.backtest?.profitFactor ?? body.backtest?.profitFactor ?? null,
      sharpe: body.result?.backtest?.sharpe ?? body.backtest?.sharpe ?? null,
    };
  }

  if (path === '/ml/registry') {
    return {
      championId: body.champion?.id ?? null,
      championKind: body.champion?.kind ?? null,
      challengers: Array.isArray(body.challengers) ? body.challengers.length : 0,
    };
  }

  if (path === '/rl/status') {
    return {
      enabled: body.enabled,
      modelKind: body.modelKind ?? null,
      lastShadowAt: body.lastShadowAt ?? null,
    };
  }

  if (path === '/ml/retrain') {
    const rl = body.rl ?? {};
    const supervised = body.supervised ?? {};
    const rlScorecard = rl.scorecard ?? null;
    const rlMetrics = rlScorecard?.metrics ?? null;
    const supervisedScorecard = supervised.scorecard ?? null;
    return {
      supervised: {
        attempted: Boolean(supervised.attempted),
        promoted: Boolean(supervised.promoted),
        reason: supervised.reason ?? null,
        scorecardReason: supervisedScorecard?.reason ?? null,
        holdoutTrades: supervisedScorecard?.metrics?.holdout?.trades ?? null,
        unseenTrades: supervisedScorecard?.metrics?.unseen?.trades ?? null,
      },
      rl: {
        attempted: Boolean(rl.attempted),
        promoted: Boolean(rl.promoted),
        reason: rl.reason ?? null,
        scorecardPresent: Boolean(rlScorecard),
        scorecardReason: rlScorecard?.reason ?? null,
        inSampleWinRate: rlMetrics?.inSample?.winRate ?? null,
        inSampleNetPnl: rlMetrics?.inSample?.netPnl ?? null,
        wfSharpe: rlMetrics?.walkForward?.sharpe ?? null,
        wfProfitFactor: rlMetrics?.walkForward?.profitFactor ?? null,
        holdoutTrades: rlMetrics?.holdout?.trades ?? null,
        unseenTrades: rlMetrics?.unseen?.trades ?? null,
        thresholds: rlScorecard?.thresholds ?? null,
        split: rlScorecard?.split ?? null,
      },
    };
  }

  return body;
};

const waitForHealth = async timeoutMs => {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const health = await getJson('/health');
      if (health.ok && health.body?.status === 'ok') {
        return {
          ready: true,
          afterMs: Date.now() - started,
          health: health.body,
        };
      }
    } catch (error) {
      lastError = String(error);
    }
    await wait(300);
  }

  return {
    ready: false,
    afterMs: Date.now() - started,
    error: lastError ?? 'health timeout',
  };
};

const startRuntime = () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];

  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    stdout.push(text);
  });

  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr.push(text);
  });

  return { child, stdout, stderr };
};

const run = async () => {
  let child = null;
  let stdout = [];
  let stderr = [];
  let ownsRuntime = false;
  const summary = {
    baseUrl: BASE_URL,
    startPid: null,
    runtimeMode: null,
    healthProbe: null,
    probes: {},
    shutdown: null,
  };

  try {
    let existingHealthy = false;
    if (USE_EXISTING_RUNTIME && !FORCE_NEW_RUNTIME) {
      try {
        const probe = await getJson('/health');
        existingHealthy = probe.ok && probe.body?.status === 'ok';
      } catch {
        existingHealthy = false;
      }
    }

    if (existingHealthy) {
      summary.runtimeMode = 'existing';
    } else {
      const runtime = startRuntime();
      child = runtime.child;
      stdout = runtime.stdout;
      stderr = runtime.stderr;
      ownsRuntime = true;
      summary.startPid = child.pid ?? null;
      summary.runtimeMode = 'spawned';
    }

    summary.healthProbe = await waitForHealth(START_TIMEOUT_MS);
    if (!summary.healthProbe.ready) {
      throw new Error(`runtime not healthy in ${summary.healthProbe.afterMs}ms`);
    }

    const health = await safeGetJson('/health');
    const runtimeStatus = await safeGetJson('/runtime/status');
    const backtestStatus = await safeGetJson('/backtest/status');
    const mlRegistry = await safeGetJson('/ml/registry');
    const rlStatus = await safeGetJson('/rl/status');
    const backtestRun = await safePostJson('/backtest/run');
    const retrainProbe = RUN_RETRAIN_PROBE ? await safePostJson('/ml/retrain') : null;

    summary.probes.health = {
      ok: health.ok,
      status: health.status,
      summary: summarizeProbe('/health', health),
    };
    summary.probes.runtimeStatus = {
      ok: runtimeStatus.ok,
      status: runtimeStatus.status,
      summary: summarizeProbe('/runtime/status', runtimeStatus),
    };
    summary.probes.backtestStatus = {
      ok: backtestStatus.ok,
      status: backtestStatus.status,
      summary: summarizeProbe('/backtest/status', backtestStatus),
    };
    summary.probes.mlRegistry = {
      ok: mlRegistry.ok,
      status: mlRegistry.status,
      summary: summarizeProbe('/ml/registry', mlRegistry),
    };
    summary.probes.rlStatus = {
      ok: rlStatus.ok,
      status: rlStatus.status,
      summary: summarizeProbe('/rl/status', rlStatus),
    };
    summary.probes.backtestRun = {
      ok: backtestRun.ok,
      status: backtestRun.status,
      summary: summarizeProbe('/backtest/run', backtestRun),
    };
    if (retrainProbe) {
      summary.probes.retrainProbe = {
        ok: retrainProbe.ok,
        status: retrainProbe.status,
        summary: summarizeProbe('/ml/retrain', retrainProbe),
      };
    }
  } finally {
    if (child && ownsRuntime) {
      child.kill('SIGTERM');
      await wait(700);
    }
    summary.shutdown = {
      exitCode: child?.exitCode ?? null,
      signalCode: child?.signalCode ?? null,
      stdoutLines: stdout.join('').split(/\r?\n/).filter(Boolean).length,
      stderrLines: stderr.join('').split(/\r?\n/).filter(Boolean).length,
    };
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
