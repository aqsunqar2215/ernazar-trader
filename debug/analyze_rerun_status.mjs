import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const statusFile = process.argv[2];
const apiPort = process.argv[3] || '8081';

if (!statusFile) {
  console.error('Usage: node debug/analyze_rerun_status.mjs <status-jsonl-path> [port]');
  process.exit(1);
}

const absStatus = path.isAbsolute(statusFile) ? statusFile : path.join(ROOT, statusFile);
if (!fs.existsSync(absStatus)) {
  console.error(`Status file not found: ${absStatus}`);
  process.exit(1);
}

const safeJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const lines = fs.readFileSync(absStatus, 'utf8').split(/\r?\n/).filter(Boolean);
const samples = lines.map(safeJson).filter(Boolean);

const rows = samples.filter(item => item.paperMetrics && item.ts);
const first = rows[0] ?? null;
const last = rows[rows.length - 1] ?? null;

const toMs = ts => (ts ? Date.parse(ts) : NaN);
const minutes = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60000 : NaN);

const healthErrors = samples.filter(item => item.ok === false).length;
const riskCounts = new Map();
for (const row of rows) {
  const reasons = row.riskReasons || {};
  for (const [reason, count] of Object.entries(reasons)) {
    riskCounts.set(reason, (riskCounts.get(reason) ?? 0) + Number(count || 0));
  }
}

const tradeChangePoints = [];
for (let i = 1; i < rows.length; i += 1) {
  const prevTrades = Number(rows[i - 1]?.paperMetrics?.trades ?? 0);
  const currTrades = Number(rows[i]?.paperMetrics?.trades ?? 0);
  if (currTrades > prevTrades) {
    tradeChangePoints.push({
      ts: rows[i].ts,
      from: prevTrades,
      to: currTrades,
      delta: currTrades - prevTrades,
    });
  }
}

const fetchJson = async endpoint => {
  const res = await fetch(`http://127.0.0.1:${apiPort}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${endpoint}`);
  return await res.json();
};

let runtime = null;
let orders = [];
let auditEvents = [];
let liveFetchError = null;

try {
  runtime = await fetchJson('/runtime/status');
  const orderPayload = await fetchJson('/runtime/orders?limit=1000');
  const auditPayload = await fetchJson('/runtime/audit?limit=5000');
  orders = orderPayload?.orders ?? [];
  auditEvents = auditPayload?.events ?? [];
} catch (error) {
  liveFetchError = String(error);
}

const orderSideCounts = orders.reduce(
  (acc, order) => {
    if (order?.side === 'buy') acc.buy += 1;
    if (order?.side === 'sell') acc.sell += 1;
    return acc;
  },
  { buy: 0, sell: 0 },
);

const guardBlocks = new Map();
const riskDecisions = new Map();
const signalActions = new Map();
for (const event of auditEvents) {
  if (event?.type === 'rl_execution_guard_blocked') {
    const reason = String(event?.payload?.reason ?? 'unknown');
    guardBlocks.set(reason, (guardBlocks.get(reason) ?? 0) + 1);
  }
  if (event?.type === 'risk_decision') {
    const reason = String(event?.payload?.reason ?? 'unknown');
    const allowed = Boolean(event?.payload?.allowed);
    const key = `${reason} | allowed=${allowed}`;
    riskDecisions.set(key, (riskDecisions.get(key) ?? 0) + 1);
  }
  if (event?.type === 'signal_generated') {
    const action = String(event?.payload?.action ?? 'unknown');
    signalActions.set(action, (signalActions.get(action) ?? 0) + 1);
  }
}

const startMs = toMs(first?.ts);
const endMs = toMs(last?.ts);
const durationMin = minutes(startMs, endMs);
const tradesDelta = Number(last?.paperMetrics?.trades ?? 0) - Number(first?.paperMetrics?.trades ?? 0);
const tph = durationMin > 0 ? (tradesDelta / durationMin) * 60 : 0;

const report = {
  statusFile: absStatus,
  samples: {
    total: samples.length,
    usable: rows.length,
    firstTs: first?.ts ?? null,
    lastTs: last?.ts ?? null,
    durationMin,
    healthErrors,
  },
  tradingFromSamples: {
    startTrades: first?.paperMetrics?.trades ?? null,
    endTrades: last?.paperMetrics?.trades ?? null,
    tradesDelta,
    estimatedTradesPerHour: tph,
    startNetPnlUsd: first?.paperMetrics?.netPnlUsd ?? null,
    endNetPnlUsd: last?.paperMetrics?.netPnlUsd ?? null,
    tradeChangePoints,
    aggregatedRiskReasons: Object.fromEntries([...riskCounts.entries()].sort((a, b) => b[1] - a[1])),
  },
  liveRuntime: {
    fetchError: liveFetchError,
    stage: runtime?.stage ?? null,
    paperMetrics: runtime?.paperMetrics ?? null,
    rlExecutionGuards: runtime?.rlExecutionGuards ?? null,
    killSwitch: runtime?.killSwitch ?? null,
    orderCount: orders.length,
    orderSides: orderSideCounts,
    signalActions: Object.fromEntries([...signalActions.entries()].sort((a, b) => b[1] - a[1])),
    guardBlocks: Object.fromEntries([...guardBlocks.entries()].sort((a, b) => b[1] - a[1])),
    riskDecisionBreakdown: Object.fromEntries([...riskDecisions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)),
  },
};

console.log(JSON.stringify(report, null, 2));
