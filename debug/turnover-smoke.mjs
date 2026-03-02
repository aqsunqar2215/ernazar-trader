import { spawn } from 'node:child_process';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS ?? '30000');
const SAMPLE_WAIT_MS = Number(process.env.SAMPLE_WAIT_MS ?? '3000');
const USE_EXISTING_RUNTIME = (process.env.USE_EXISTING_RUNTIME ?? '0') !== '0';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const getJson = async path => {
  const res = await fetch(`${BASE_URL}${path}`);
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
      body: { error: String(error) },
    };
  }
};

const waitForHealth = async timeoutMs => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = await safeGetJson('/health');
    if (probe.ok && probe.body?.status === 'ok') return true;
    await wait(300);
  }
  return false;
};

const startRuntime = () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return { child };
};

const summarizeReasons = events => {
  const counts = new Map();
  for (const event of events) {
    const reason = String(event?.payload?.reason ?? 'unknown');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
};

const run = async () => {
  let child = null;
  let ownsRuntime = false;
  let runtimeMode = 'existing';

  if (!USE_EXISTING_RUNTIME) {
    runtimeMode = 'spawned';
    const runtime = startRuntime();
    child = runtime.child;
    ownsRuntime = true;
  } else {
    const health = await safeGetJson('/health');
    const hasExisting = health.ok && health.body?.status === 'ok';
    if (!hasExisting) {
      runtimeMode = 'spawned';
      const runtime = startRuntime();
      child = runtime.child;
      ownsRuntime = true;
    }
  }

  const healthy = await waitForHealth(START_TIMEOUT_MS);
  if (!healthy) {
    throw new Error('runtime not healthy within timeout');
  }

  await wait(SAMPLE_WAIT_MS);

  const { RiskEngine } = await import('../dist/risk/risk-engine.js');
  const { StateDb } = await import('../dist/state/db.js');
  const { config } = await import('../dist/core/config.js');

  const maxTurnoverPerHour = Number(
    process.env.TEST_MAX_TURNOVER_PER_HOUR
      ?? (config.risk.maxTurnoverPerHour > 0 ? config.risk.maxTurnoverPerHour : 2),
  );
  const limits = {
    maxRiskPerTradePct: Number(process.env.TEST_MAX_RISK_PER_TRADE_PCT ?? config.risk.maxRiskPerTradePct),
    maxDailyLossUsd: Number(process.env.TEST_MAX_DAILY_LOSS_USD ?? config.risk.maxDailyLossUsd),
    maxDrawdownPct: Number(process.env.TEST_MAX_DRAWDOWN_PCT ?? config.risk.maxDrawdownPct),
    maxOrdersPerMinute: Number(process.env.TEST_MAX_ORDERS_PER_MINUTE ?? config.risk.maxOrdersPerMinute),
    maxTurnoverPerHour,
    cooldownLossStreak: Number(process.env.TEST_COOLDOWN_LOSS_STREAK ?? config.risk.cooldownLossStreak),
  };

  const risk = new RiskEngine(limits);
  const db = new StateDb(config.db.path);
  const baseState = {
    equityUsd: 10_000,
    peakEquityUsd: 10_000,
    dailyPnlUsd: 0,
    recentLossStreak: 0,
    ordersLastMinute: 0,
    turnoverLastHour: 0,
    turnoverForSignal: 1,
    killSwitch: false,
  };
  const signal = {
    symbol: 'BTCUSDT',
    timeframe: '1m',
    action: 'buy',
    strength: 0.5,
    reason: 'synthetic',
    timestamp: Date.now(),
  };

  const allowedDecision = risk.check(signal, {
    ...baseState,
    turnoverLastHour: Math.max(0, limits.maxTurnoverPerHour - 1),
  });
  const blockedDecision = risk.check(signal, {
    ...baseState,
    turnoverLastHour: limits.maxTurnoverPerHour,
  });

  const now = Date.now();
  const syntheticEvents = [
    {
      id: `synthetic-allowed-${now}`,
      type: 'risk_decision',
      timestamp: now,
      payload: {
        synthetic: true,
        case: 'below_limit',
        signal,
        allowed: allowedDecision.allowed,
        reason: allowedDecision.reason,
        maxSizeUsd: allowedDecision.maxSizeUsd ?? null,
        turnoverLastHour: Math.max(0, limits.maxTurnoverPerHour - 1),
        turnoverForSignal: baseState.turnoverForSignal,
        maxTurnoverPerHour: limits.maxTurnoverPerHour,
      },
    },
    {
      id: `synthetic-blocked-${now + 1}`,
      type: 'risk_decision',
      timestamp: now + 1,
      payload: {
        synthetic: true,
        case: 'exceeds_limit',
        signal,
        allowed: blockedDecision.allowed,
        reason: blockedDecision.reason,
        maxSizeUsd: blockedDecision.maxSizeUsd ?? null,
        turnoverLastHour: limits.maxTurnoverPerHour,
        turnoverForSignal: baseState.turnoverForSignal,
        maxTurnoverPerHour: limits.maxTurnoverPerHour,
      },
    },
  ];

  for (const event of syntheticEvents) {
    db.insertAudit(event);
  }
  db.close();

  const health = await safeGetJson('/health');
  const uptimeMs = Number(health.body?.uptimeMs ?? 0);
  const windowStartMs = Number.isFinite(uptimeMs) && uptimeMs > 0 ? Date.now() - uptimeMs : 0;

  const audit = await safeGetJson('/runtime/audit?limit=2000');
  const auditEvents = audit.body?.events ?? [];
  const riskDecisions = auditEvents
    .filter(event => event?.type === 'risk_decision')
    .filter(event => !windowStartMs || (Number.isFinite(event.timestamp) && event.timestamp >= windowStartMs));
  const syntheticEvidence = riskDecisions.filter(event => event?.payload?.synthetic === true);
  const turnoverBlocks = riskDecisions.filter(event =>
    String(event?.payload?.reason ?? '').includes('max turnover per hour breached'),
  );

  const result = {
    baseUrl: BASE_URL,
    runtimeMode,
    sampleWaitMs: SAMPLE_WAIT_MS,
    auditEventsCount: Array.isArray(auditEvents) ? auditEvents.length : 0,
    auditWindowStartMs: windowStartMs || null,
    auditFirstTs: auditEvents[0]?.timestamp ?? null,
    auditLastTs: auditEvents.length > 0 ? auditEvents[auditEvents.length - 1]?.timestamp ?? null : null,
    auditTypeSample: auditEvents.slice(0, 10).map(event => event?.type ?? null),
    riskDecisionCount: riskDecisions.length,
    turnoverBlockCount: turnoverBlocks.length,
    syntheticEvidence: syntheticEvidence.slice(0, 4).map(event => ({
      ts: event.timestamp ?? null,
      reason: event?.payload?.reason ?? null,
      allowed: event?.payload?.allowed ?? null,
      case: event?.payload?.case ?? null,
      turnoverLastHour: event?.payload?.turnoverLastHour ?? null,
      turnoverForSignal: event?.payload?.turnoverForSignal ?? null,
      maxTurnoverPerHour: event?.payload?.maxTurnoverPerHour ?? null,
    })),
    topReasons: summarizeReasons(riskDecisions),
  };

  process.stdout.write(`TURNOVER_SMOKE ${JSON.stringify(result)}\n`);
  if (child && ownsRuntime) {
    child.kill('SIGTERM');
    await wait(700);
  }

  if (result.turnoverBlockCount === 0) process.exitCode = 2;
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
