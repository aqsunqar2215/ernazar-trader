import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const runId = process.env.RUN_ID;
const port = process.env.RUNTIME_PORT || '8081';
const durationMs = Number(process.env.DURATION_MS || 60 * 60 * 1000);
const pollMs = Number(process.env.POLL_MS || 30 * 1000);
const outPath = process.env.STATUS_PATH || path.join(ROOT, 'debug', `live-paper-status-rerun-${runId || 'unknown'}.jsonl`);

const base = `http://127.0.0.1:${port}`;
const endAt = Date.now() + durationMs;
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchJson = async url => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.json();
};

const countReasons = events => {
  const out = {};
  for (const event of events) {
    if (!event || event.type !== 'risk_decision') continue;
    const reason = String(event?.payload?.reason ?? 'unknown');
    out[reason] = (out[reason] || 0) + 1;
  }
  return out;
};

while (Date.now() < endAt) {
  const row = { ts: new Date().toISOString(), ok: true };
  try {
    const [health, status, audit] = await Promise.all([
      fetchJson(`${base}/health`),
      fetchJson(`${base}/runtime/status`),
      fetchJson(`${base}/runtime/audit?limit=300`),
    ]);
    row.health = health;
    row.stage = status?.stage ?? null;
    row.paperMetrics = status?.paperMetrics ?? null;
    row.equityUsd = status?.equityUsd ?? null;
    row.realizedPnlUsd = status?.realizedPnlUsd ?? null;
    row.unrealizedPnlUsd = status?.unrealizedPnlUsd ?? null;
    row.rlExecutionGuards = status?.rlExecutionGuards ?? null;
    row.riskReasons = countReasons(audit?.events ?? []);
  } catch (error) {
    row.ok = false;
    row.error = String(error);
  }
  fs.appendFileSync(outPath, `${JSON.stringify(row)}\n`);
  await sleep(pollMs);
}

fs.appendFileSync(
  outPath,
  `${JSON.stringify({ ts: new Date().toISOString(), ok: true, message: 'poller finished' })}\n`,
);
