import fs from 'node:fs';
import path from 'node:path';

const [baselinePathArg, candidatePathArg, outPathArg] = process.argv.slice(2);

if (!baselinePathArg || !candidatePathArg) {
  console.error('Usage: node debug/compare_status_runs.mjs <baseline-status.jsonl> <candidate-status.jsonl> [out.json]');
  process.exit(1);
}

const ROOT = process.cwd();
const resolvePath = p => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const baselinePath = resolvePath(baselinePathArg);
const candidatePath = resolvePath(candidatePathArg);
const outPath = resolvePath(outPathArg || path.join('debug', `comparison-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

const loadRows = filePath => {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(item => item && item.paperMetrics && item.ts);
};

const toSummary = rows => {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const startMs = first ? Date.parse(first.ts) : NaN;
  const endMs = last ? Date.parse(last.ts) : NaN;
  const durationMin = Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 60000 : 0;
  const tradesStart = Number(first?.paperMetrics?.trades ?? 0);
  const tradesEnd = Number(last?.paperMetrics?.trades ?? 0);
  const tradesDelta = tradesEnd - tradesStart;
  return {
    samples: rows.length,
    firstTs: first?.ts ?? null,
    lastTs: last?.ts ?? null,
    durationMin,
    tradesStart,
    tradesEnd,
    tradesDelta,
    tradesPerMinute: durationMin > 0 ? tradesDelta / durationMin : 0,
    endProfitFactor: Number(last?.paperMetrics?.profitFactor ?? 0),
    endNetPnlUsd: Number(last?.paperMetrics?.netPnlUsd ?? 0),
    endMaxDrawdownPct: Number(last?.paperMetrics?.maxDrawdownPct ?? 0),
    endWinRate: Number(last?.paperMetrics?.winRate ?? 0),
  };
};

const baselineRows = loadRows(baselinePath);
const candidateRows = loadRows(candidatePath);
const baseline = toSummary(baselineRows);
const candidate = toSummary(candidateRows);

const comparison = {
  profitFactor: {
    baseline: baseline.endProfitFactor,
    candidate: candidate.endProfitFactor,
    delta: candidate.endProfitFactor - baseline.endProfitFactor,
    betterOrEqual: candidate.endProfitFactor >= baseline.endProfitFactor,
  },
  netPnlUsd: {
    baseline: baseline.endNetPnlUsd,
    candidate: candidate.endNetPnlUsd,
    delta: candidate.endNetPnlUsd - baseline.endNetPnlUsd,
    betterOrEqual: candidate.endNetPnlUsd >= baseline.endNetPnlUsd,
  },
  maxDrawdownPct: {
    baseline: baseline.endMaxDrawdownPct,
    candidate: candidate.endMaxDrawdownPct,
    delta: candidate.endMaxDrawdownPct - baseline.endMaxDrawdownPct,
    betterOrEqual: candidate.endMaxDrawdownPct <= baseline.endMaxDrawdownPct,
  },
  tradesPerMinute: {
    baseline: baseline.tradesPerMinute,
    candidate: candidate.tradesPerMinute,
    delta: candidate.tradesPerMinute - baseline.tradesPerMinute,
    betterOrEqual: candidate.tradesPerMinute >= baseline.tradesPerMinute,
  },
};

const promoteTinyLive =
  comparison.profitFactor.betterOrEqual &&
  comparison.netPnlUsd.betterOrEqual &&
  comparison.maxDrawdownPct.betterOrEqual &&
  comparison.tradesPerMinute.betterOrEqual;

const result = {
  createdAt: new Date().toISOString(),
  baselinePath,
  candidatePath,
  baseline,
  candidate,
  comparison,
  promoteTinyLive,
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: 'ok', outPath, promoteTinyLive }));
