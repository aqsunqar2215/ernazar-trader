import { spawn } from 'node:child_process';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const DEFAULT_TARGET_TRADES = 20;
const TARGET_TRADES_ENV = process.env.TARGET_TRADES;
const TARGET_TRADES = TARGET_TRADES_ENV ? Number(TARGET_TRADES_ENV) : null;
const POLL_MS = Number(process.env.POLL_MS ?? '10000');
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS ?? '30000');
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? '1800000');
const USE_EXISTING_RUNTIME = (process.env.USE_EXISTING_RUNTIME ?? '1') !== '0';
const REPORT_PATH = process.env.REPORT_PATH ?? 'debug/shadow-report-latest.json';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const parseEnvNumber = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

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

const summarize = (rlStatus, runtimeStatus) => {
  const rl = rlStatus?.body ?? {};
  const rt = runtimeStatus?.body ?? {};
  return {
    ts: new Date().toISOString(),
    rlTrades: Number(rl.trades ?? 0),
    rlWinRate: rl.winRate ?? null,
    rlProfitFactor: rl.profitFactor ?? null,
    rlNetPnlUsd: rl.netPnlUsd ?? null,
    rlMaxDrawdownPct: rl.maxDrawdownPct ?? null,
    rlQGapStats: rl.qGapStats ?? null,
    rlRegimeStats: rl.regimeStats ?? null,
    runtimeStage: rt.stage ?? null,
    runtimePaperTrades: rt.paperMetrics?.trades ?? null,
    runtimePaperProfitFactor: rt.paperMetrics?.profitFactor ?? null,
  };
};

const toQueryPath = (path, limit) => `${path}?limit=${encodeURIComponent(String(limit))}`;

const computeSampleStats = samples => {
  if (!Array.isArray(samples) || samples.length === 0) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const firstTradeSample = samples.find(item => Number(item.rlTrades) > 0) ?? null;
  const maxObservedDrawdown = samples.reduce((max, item) => Math.max(max, Number(item.rlMaxDrawdownPct ?? 0)), 0);
  const minNetPnl = samples.reduce((min, item) => Math.min(min, Number(item.rlNetPnlUsd ?? 0)), Number.POSITIVE_INFINITY);
  const maxNetPnl = samples.reduce((max, item) => Math.max(max, Number(item.rlNetPnlUsd ?? 0)), Number.NEGATIVE_INFINITY);

  const startedAtMs = Date.parse(first.ts);
  const endedAtMs = Date.parse(last.ts);
  const elapsedMinutes = Number.isFinite(endedAtMs - startedAtMs) ? (endedAtMs - startedAtMs) / 60_000 : null;
  const tradesDelta = Number(last.rlTrades ?? 0) - Number(first.rlTrades ?? 0);

  return {
    firstTradeTs: firstTradeSample?.ts ?? null,
    firstTradeRlTrades: firstTradeSample?.rlTrades ?? null,
    maxObservedDrawdownPct: maxObservedDrawdown,
    minObservedNetPnlUsd: Number.isFinite(minNetPnl) ? minNetPnl : null,
    maxObservedNetPnlUsd: Number.isFinite(maxNetPnl) ? maxNetPnl : null,
    elapsedMinutes,
    tradesPerMinute: elapsedMinutes && elapsedMinutes > 0 ? tradesDelta / elapsedMinutes : null,
  };
};

const pickAuditPreview = events => {
  if (!Array.isArray(events)) return [];
  return events.slice(-20).map(event => ({
    ts: event.timestamp ?? event.ts ?? null,
    type: event.type ?? null,
    severity: event.severity ?? null,
    symbol: event.symbol ?? null,
    detail: event.message ?? event.reason ?? null,
  }));
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

  const startedAt = Date.now();
  const samples = [];
  let finalRl = null;
  let finalRuntime = null;
  let effectiveMaxWaitMs = MAX_WAIT_MS;
  let targetTrades = TARGET_TRADES;

  while (Date.now() - startedAt < effectiveMaxWaitMs) {
    const [rlStatus, runtimeStatus] = await Promise.all([
      safeGetJson('/rl/status'),
      safeGetJson('/runtime/status'),
    ]);

    finalRl = rlStatus;
    finalRuntime = runtimeStatus;
    const shadowGate = runtimeStatus?.body?.shadowGate ?? null;
    if (!Number.isFinite(targetTrades ?? Number.NaN)) {
      const tier = Number(shadowGate?.tier);
      targetTrades = Number.isFinite(tier) && tier > 0 ? tier : DEFAULT_TARGET_TRADES;
    }
    const gateTimeoutMs = Number(shadowGate?.limits?.timeoutMs);
    if (Number.isFinite(gateTimeoutMs) && gateTimeoutMs > 0) {
      effectiveMaxWaitMs = Math.min(MAX_WAIT_MS, gateTimeoutMs);
    }
    const snapshot = summarize(rlStatus, runtimeStatus);
    samples.push(snapshot);
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);

    if (Number.isFinite(targetTrades ?? Number.NaN) && snapshot.rlTrades >= targetTrades) break;
    await wait(POLL_MS);
  }

  const elapsedMs = Date.now() - startedAt;
  const final = summarize(finalRl, finalRuntime);
  const sampleStats = computeSampleStats(samples);

  const [alerts, audit, fills, orders, equity, finalRlFull, finalRuntimeFull] = await Promise.all([
    safeGetJson(toQueryPath('/runtime/alerts', 1000)),
    safeGetJson(toQueryPath('/runtime/audit', 2000)),
    safeGetJson(toQueryPath('/runtime/fills', 3000)),
    safeGetJson(toQueryPath('/runtime/orders', 3000)),
    safeGetJson(toQueryPath('/runtime/equity', 3000)),
    safeGetJson('/rl/status'),
    safeGetJson('/runtime/status'),
  ]);

  const alertsList = alerts.body?.alerts ?? [];
  const auditEvents = audit.body?.events ?? [];
  const fillsList = fills.body?.fills ?? [];
  const ordersList = orders.body?.orders ?? [];
  const equityPoints = equity.body?.equity ?? [];
  const resolvedTargetTrades = Number.isFinite(targetTrades ?? Number.NaN)
    ? targetTrades
    : DEFAULT_TARGET_TRADES;
  const reachedTarget = final.rlTrades >= resolvedTargetTrades;

  const windowStartMs = (() => {
    if (sampleStats?.firstTradeTs) {
      const parsed = Date.parse(sampleStats.firstTradeTs);
      if (Number.isFinite(parsed)) return parsed;
    }
    return startedAt;
  })();
  const windowEndMs = Date.now();
  const criticalAlertTypes = new Set(['drawdown_breach', 'risk_limit', 'order_failure', 'data_feed_down', 'kill_switch']);
  const criticalAlerts = Array.isArray(alertsList)
    ? alertsList.filter(alert =>
      alert
      && alert.level === 'critical'
      && criticalAlertTypes.has(alert.type)
      && Number.isFinite(alert.timestamp)
      && alert.timestamp >= windowStartMs
      && alert.timestamp <= windowEndMs,
    )
      .map(alert => ({
        id: alert.id ?? null,
        type: alert.type ?? null,
        level: alert.level ?? null,
        message: alert.message ?? null,
        timestamp: alert.timestamp ?? null,
        meta: alert.meta ?? null,
      }))
    : [];
  const killSwitchEnabled = Boolean(finalRuntimeFull.body?.killSwitch?.enabled);
  const localPaperSanity = {
    passed: !killSwitchEnabled && criticalAlerts.length === 0,
    reason: killSwitchEnabled ? 'kill_switch_enabled' : criticalAlerts.length > 0 ? 'critical_alerts' : 'ok',
    killSwitchEnabled,
    criticalAlertsCount: criticalAlerts.length,
  };
  const runtimePaperSanity = finalRuntimeFull.body?.paperSanity ?? null;
  const paperSanity = runtimePaperSanity ?? localPaperSanity;
  const runtimeShadowGate = finalRuntimeFull.body?.shadowGate ?? null;
  const localGateLimits = {
    tradesPerMinute: parseEnvNumber('RL_SHADOW_GATE_MAX_TPM', 4),
    profitFactor: parseEnvNumber('RL_SHADOW_GATE_MIN_PF', 1.12),
    netPnlUsd: parseEnvNumber('RL_SHADOW_GATE_MIN_NET_PNL_USD', 0),
    maxDrawdownPct: parseEnvNumber('RL_SHADOW_GATE_MAX_DD_PCT', 0.01),
  };
  const kpi = {
    tradesPerMinute: sampleStats?.tradesPerMinute ?? null,
    profitFactor: Number(final.rlProfitFactor ?? 0),
    netPnlUsd: Number(final.rlNetPnlUsd ?? 0),
    maxDrawdownPct: Number(final.rlMaxDrawdownPct ?? 0),
  };
  const kpiPass = Number.isFinite(kpi.tradesPerMinute)
    && kpi.tradesPerMinute <= localGateLimits.tradesPerMinute
    && kpi.profitFactor >= localGateLimits.profitFactor
    && kpi.netPnlUsd >= localGateLimits.netPnlUsd
    && kpi.maxDrawdownPct <= localGateLimits.maxDrawdownPct;
  const localGate = {
    passed: reachedTarget && kpiPass,
    reason: !reachedTarget ? 'gate_timeout' : kpiPass ? 'pass' : 'kpi_fail',
    kpi,
    limits: localGateLimits,
  };
  const runtimeGateTrades = Number(runtimeShadowGate?.trades ?? 0);
  const runtimeGateAwaitingTradesStale = Boolean(
    runtimeShadowGate &&
    runtimeShadowGate.reason === 'awaiting_trades' &&
    reachedTarget &&
    runtimeGateTrades < final.rlTrades,
  );
  const runtimeGateKpiMismatchStale = Boolean(
    runtimeShadowGate &&
    runtimeShadowGate.reason === 'kpi_fail' &&
    reachedTarget &&
    localGate.passed,
  );
  const runtimeGateStale = runtimeGateAwaitingTradesStale || runtimeGateKpiMismatchStale;
  const gate = runtimeGateStale ? localGate : (runtimeShadowGate ?? localGate);
  const overallPassed = Boolean(gate?.passed) && Boolean(paperSanity?.passed);

  const result = {
    baseUrl: BASE_URL,
    runtimeMode,
    targetTrades: resolvedTargetTrades,
    reachedTarget,
    elapsedMs,
    maxWaitMs: effectiveMaxWaitMs,
    gateTimeoutMs: gate?.limits?.timeoutMs ?? null,
    runtimeGateStale,
    gate,
    paperSanity,
    overallPassed,
    alertWindow: {
      startMs: windowStartMs,
      endMs: windowEndMs,
      startIso: new Date(windowStartMs).toISOString(),
      endIso: new Date(windowEndMs).toISOString(),
    },
    criticalAlerts,
    final,
    guardBlocks: finalRlFull.body?.guardBlocks ?? null,
    sampleStats,
    samplesCount: samples.length,
    lastSamples: samples.slice(-5),
    runtimeData: {
      alertsCount: Array.isArray(alertsList) ? alertsList.length : 0,
      auditEventsCount: Array.isArray(auditEvents) ? auditEvents.length : 0,
      fillsCount: Array.isArray(fillsList) ? fillsList.length : 0,
      ordersCount: Array.isArray(ordersList) ? ordersList.length : 0,
      equityPoints: Array.isArray(equityPoints) ? equityPoints.length : 0,
      alertsTail: Array.isArray(alertsList) ? alertsList.slice(-10) : [],
      auditTail: pickAuditPreview(auditEvents),
    },
    finalSnapshots: {
      rlStatus: finalRlFull.body ?? null,
      runtimeStatus: finalRuntimeFull.body ?? null,
    },
  };

  const fs = await import('node:fs/promises');
  await fs.writeFile(REPORT_PATH, JSON.stringify(result, null, 2), 'utf8');

  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  if (!result.overallPassed) process.exitCode = 2;

  if (child && ownsRuntime) {
    child.kill('SIGTERM');
    await wait(700);
  }
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
