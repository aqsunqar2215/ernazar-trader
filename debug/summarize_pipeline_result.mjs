import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node debug/summarize_pipeline_result.mjs <final-json-path>');
  process.exit(1);
}

const filePath = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
if (!fs.existsSync(filePath)) {
  console.error(JSON.stringify({ status: 'missing', filePath }));
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const attempts = Array.isArray(data?.smokeFinal?.attempts)
  ? data.smokeFinal.attempts
  : Array.isArray(data?.attempts)
    ? data.attempts
    : [];

const attemptsSummary = attempts.map(item => ({
  attempt: item.attempt,
  runId: item.runId,
  code: item.code,
  reachedTarget: item.report?.reachedTarget ?? null,
  gatePassed: item.report?.gate?.passed ?? null,
  gateReason: item.report?.gate?.reason ?? null,
  paperSanityPassed: item.report?.paperSanity?.passed ?? null,
  rlTrades: item.report?.final?.rlTrades ?? null,
  pf: item.report?.final?.rlProfitFactor ?? null,
  netPnlUsd: item.report?.final?.rlNetPnlUsd ?? null,
  maxDdPct: item.report?.final?.rlMaxDrawdownPct ?? null,
  tpm: item.report?.gate?.kpi?.tradesPerMinute ?? null,
}));

const summary = {
  filePath,
  status: data.status ?? null,
  reason: data.reason ?? null,
  pipelineId: data.pipelineId ?? null,
  promoteTinyLive: data.promoteTinyLive ?? null,
  comparisonOutPath: data.comparisonOutPath ?? null,
  attemptsCount: attemptsSummary.length,
  attempts: attemptsSummary,
};

console.log(JSON.stringify(summary, null, 2));
