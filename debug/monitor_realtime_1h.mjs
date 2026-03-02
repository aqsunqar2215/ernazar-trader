import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const API_BASE = 'http://127.0.0.1:8080';
const DURATION_MS = 60 * 60 * 1000;
const POLL_MS = 30 * 1000;
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000;

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'debug');
const summaryPath = path.join(outDir, `realtime-1h-summary-${runId}.json`);
const samplesPath = path.join(outDir, `realtime-1h-samples-${runId}.jsonl`);
const childLogPath = path.join(outDir, `realtime-1h-runtime-${runId}.log`);
const fileLogPath = path.join(outDir, 'live-paper-runtime.log');

fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchJson = async endpoint => {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${endpoint}`);
  }
  return await res.json();
};

const hasLocalRuntime = async () => {
  try {
    const health = await fetchJson('/health');
    return Boolean(health?.status === 'ok');
  } catch {
    return false;
  }
};

const waitForHealth = async timeoutMs => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await hasLocalRuntime()) return true;
    await sleep(2000);
  }
  return false;
};

const parseJsonLine = line => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const readNewLogLines = (cursor, maxLines = 2000) => {
  if (!fs.existsSync(fileLogPath)) {
    return { nextCursor: cursor, lines: [] };
  }
  const raw = fs.readFileSync(fileLogPath, 'utf8');
  if (raw.length <= cursor) {
    return { nextCursor: raw.length, lines: [] };
  }
  const nextChunk = raw.slice(cursor);
  const lines = nextChunk.split(/\r?\n/).filter(Boolean);
  const clipped = lines.slice(-maxLines);
  return { nextCursor: raw.length, lines: clipped };
};

const collectRiskReasons = auditEvents => {
  const counts = new Map();
  for (const event of auditEvents) {
    if (event?.type !== 'risk_decision') continue;
    const reason = String(event?.payload?.reason ?? 'unknown');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
};

const collectGuardReasons = auditEvents => {
  const counts = new Map();
  for (const event of auditEvents) {
    if (event?.type !== 'rl_execution_guard_blocked') continue;
    const reason = String(event?.payload?.reason ?? 'unknown');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
};

const mergeReasonCounters = counters => {
  const merged = new Map();
  for (const item of counters) {
    if (!item || typeof item !== 'object') continue;
    for (const [reason, count] of Object.entries(item)) {
      merged.set(reason, (merged.get(reason) ?? 0) + Number(count || 0));
    }
  }
  return Object.fromEntries([...merged.entries()].sort((a, b) => b[1] - a[1]));
};

const run = async () => {
  const monitorStream = fs.createWriteStream(samplesPath, { flags: 'a' });
  const launchedOwnRuntime = !(await hasLocalRuntime());
  let child = null;
  let childLogStream = null;

  if (launchedOwnRuntime) {
    childLogStream = fs.createWriteStream(childLogPath, { flags: 'a' });
    child = spawn('npm', ['run', 'dev'], {
      cwd: ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => childLogStream.write(chunk));
    child.stderr.on('data', chunk => childLogStream.write(chunk));
    child.on('exit', (code, signal) => {
      childLogStream.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          scope: 'monitor',
          message: 'runtime child exited',
          code,
          signal,
        })}\n`,
      );
    });

    const ok = await waitForHealth(STARTUP_TIMEOUT_MS);
    if (!ok) {
      child.kill('SIGINT');
      childLogStream.end();
      throw new Error('Runtime did not become healthy in startup timeout');
    }
  }

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MS;
  let logCursor = fs.existsSync(fileLogPath) ? fs.statSync(fileLogPath).size : 0;
  let snapshots = [];
  let healthErrors = 0;
  let logWarnCount = 0;
  let logErrorCount = 0;

  while (Date.now() < deadline) {
    const ts = new Date().toISOString();
    let health = null;
    let status = null;
    let orders = [];
    let positions = [];
    let auditEvents = [];
    let pollError = null;

    try {
      [health, status] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/runtime/status'),
      ]);
      const [ordersPayload, positionsPayload, auditPayload] = await Promise.all([
        fetchJson('/runtime/orders?limit=250'),
        fetchJson('/runtime/positions'),
        fetchJson('/runtime/audit?limit=600'),
      ]);
      orders = ordersPayload?.orders ?? [];
      positions = positionsPayload?.positions ?? [];
      auditEvents = auditPayload?.events ?? [];
    } catch (error) {
      healthErrors += 1;
      pollError = String(error);
    }

    const { nextCursor, lines } = readNewLogLines(logCursor);
    logCursor = nextCursor;
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed) continue;
      if (parsed.level === 'warn') logWarnCount += 1;
      if (parsed.level === 'error') logErrorCount += 1;
    }

    const riskReasons = collectRiskReasons(auditEvents);
    const guardReasons = collectGuardReasons(auditEvents);
    const sample = {
      ts,
      ok: pollError === null,
      pollError,
      healthStatus: health?.status ?? null,
      uptimeMs: health?.uptimeMs ?? null,
      stage: status?.stage ?? null,
      paperMetrics: status?.paperMetrics ?? null,
      rlExecutionGuards: status?.rlExecutionGuards ?? null,
      killSwitch: status?.killSwitch ?? null,
      equityUsd: status?.equityUsd ?? null,
      realizedPnlUsd: status?.realizedPnlUsd ?? null,
      unrealizedPnlUsd: status?.unrealizedPnlUsd ?? null,
      positionsCount: Array.isArray(positions) ? positions.length : null,
      openPositions: positions,
      ordersCount: Array.isArray(orders) ? orders.length : null,
      latestOrder: Array.isArray(orders) && orders.length > 0 ? orders[0] : null,
      riskReasons,
      guardReasons,
      newLogLines: lines.length,
      cumulativeLogWarnCount: logWarnCount,
      cumulativeLogErrorCount: logErrorCount,
    };

    snapshots.push(sample);
    monitorStream.write(`${JSON.stringify(sample)}\n`);
    await sleep(POLL_MS);
  }

  if (child) {
    child.kill('SIGINT');
    await sleep(3000);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    childLogStream?.end();
  }
  monitorStream.end();

  const first = snapshots[0] ?? null;
  const last = snapshots[snapshots.length - 1] ?? null;
  const summary = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMinutes: Math.round((Date.now() - startedAt) / 60000),
    launchedOwnRuntime,
    files: {
      samplesPath,
      summaryPath,
      childLogPath: launchedOwnRuntime ? childLogPath : null,
      fileLogPath: fs.existsSync(fileLogPath) ? fileLogPath : null,
    },
    sampleCount: snapshots.length,
    healthErrorCount: healthErrors,
    cumulativeLogWarnCount: logWarnCount,
    cumulativeLogErrorCount: logErrorCount,
    startState: first,
    endState: last,
    tradesDelta:
      (last?.paperMetrics?.trades ?? 0) -
      (first?.paperMetrics?.trades ?? 0),
    netPnlDeltaUsd:
      (last?.paperMetrics?.netPnlUsd ?? 0) -
      (first?.paperMetrics?.netPnlUsd ?? 0),
    winDelta:
      (last?.paperMetrics?.wins ?? 0) -
      (first?.paperMetrics?.wins ?? 0),
    lossDelta:
      (last?.paperMetrics?.losses ?? 0) -
      (first?.paperMetrics?.losses ?? 0),
    aggregatedRiskReasons: mergeReasonCounters(snapshots.map(s => s.riskReasons)),
    aggregatedGuardReasons: mergeReasonCounters(snapshots.map(s => s.guardReasons)),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: 'ok', summaryPath, samplesPath, runId }));
};

run().catch(error => {
  console.error(
    JSON.stringify({
      status: 'error',
      message: String(error),
      runId,
      summaryPath,
      samplesPath,
    }),
  );
  process.exit(1);
});
