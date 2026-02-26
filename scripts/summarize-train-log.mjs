import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node scripts/summarize-train-log.mjs <logPath>');
  process.exit(2);
}

const rl = readline.createInterface({
  input: createReadStream(logPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let trainIterations = 0;
let lastIter = null;
let bestIter = null;
let bestNetPnl = Number.NEGATIVE_INFINITY;
let bestLine = null;
let summary = null;
let trainFailed = null;
let heartbeatStale = 0;
let fetchFailures = 0;

const toNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

for await (const line of rl) {
  if (!line) continue;

  const lower = line.toLowerCase();
  if (lower.includes('heartbeat') && lower.includes('stale')) heartbeatStale += 1;
  if (lower.includes('fetch') && (lower.includes('failed') || lower.includes('error'))) fetchFailures += 1;

  if (line.includes('"message":"train iteration"')) {
    try {
      const payload = JSON.parse(line);
      trainIterations += 1;
      lastIter = payload.iter ?? lastIter;
      const netPnl = toNumber(payload.netPnl);
      if (netPnl !== null && netPnl > bestNetPnl) {
        bestNetPnl = netPnl;
        bestIter = payload.iter ?? bestIter;
        bestLine = payload;
      }
    } catch {
      // ignore malformed line
    }
  } else if (line.includes('"message":"target reached after full run"')) {
    try {
      summary = JSON.parse(line);
    } catch {
      summary = { message: 'target reached after full run (unparsed)' };
    }
  } else if (line.includes('"message":"target not reached"')) {
    try {
      summary = JSON.parse(line);
    } catch {
      summary = { message: 'target not reached (unparsed)' };
    }
  } else if (line.includes('"message":"train-until-target failed"')) {
    try {
      trainFailed = JSON.parse(line);
    } catch {
      trainFailed = { message: 'train-until-target failed (unparsed)' };
    }
  }
}

const result = {
  logPath,
  trainIterations,
  lastIter,
  bestIter,
  bestNetPnl: Number.isFinite(bestNetPnl) ? bestNetPnl : null,
  heartbeatStale,
  fetchFailures,
  summary,
  trainFailed,
  bestLine,
};

console.log(JSON.stringify(result, null, 2));
