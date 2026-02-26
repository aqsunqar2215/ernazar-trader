import fs from 'node:fs';

const file = process.argv[2] ?? 'train-bg.log';

if (!fs.existsSync(file)) {
  console.error(`log file not found: ${file}`);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);

const summary = {
  file,
  totalLines: lines.length,
  jsonLines: 0,
  nonJsonLines: 0,
  nonJsonSamples: [],
  levels: {},
  messages: {},
  trainIterations: 0,
  trainIterationsPromoted: 0,
  trainIterationsAttempted: 0,
  trainIterationsWithZeroWinRate: 0,
  trainIterationsWithZeroNetPnl: 0,
  iterationReasons: {},
  rlRetrainCount: 0,
  rlPromotedCount: 0,
  rlReasons: {},
  rlInSampleNetPnl: {
    zero: 0,
    positive: 0,
    negative: 0,
  },
  supervisedRetrainCount: 0,
  supervisedPromotedCount: 0,
  supervisedReasons: {},
  paperTrades: {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    zeroCount: 0,
  },
  criticalEvents: 0,
  criticalMessages: {},
  firstTimestamp: null,
  lastTimestamp: null,
  hasTargetReached: false,
  hasTargetNotReached: false,
};

const asNumber = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
    summary.jsonLines += 1;
  } catch {
    summary.nonJsonLines += 1;
    if (summary.nonJsonSamples.length < 10) {
      summary.nonJsonSamples.push(line);
    }
    continue;
  }

  const level = String(obj.level ?? 'unknown');
  summary.levels[level] = (summary.levels[level] ?? 0) + 1;

  const message = String(obj.message ?? 'unknown');
  summary.messages[message] = (summary.messages[message] ?? 0) + 1;

  if (typeof obj.ts === 'string') {
    if (!summary.firstTimestamp) summary.firstTimestamp = obj.ts;
    summary.lastTimestamp = obj.ts;
  }

  if (level === 'critical') {
    summary.criticalEvents += 1;
    summary.criticalMessages[message] = (summary.criticalMessages[message] ?? 0) + 1;
  }

  if (message === 'target reached after full run') summary.hasTargetReached = true;
  if (message === 'target not reached') summary.hasTargetNotReached = true;

  if (message === 'train iteration') {
    summary.trainIterations += 1;
    if (obj.attempted === true) summary.trainIterationsAttempted += 1;
    if (obj.promoted === true) summary.trainIterationsPromoted += 1;

    const winRate = String(obj.winRate ?? '');
    if (winRate === '0.00%') summary.trainIterationsWithZeroWinRate += 1;

    const netPnl = String(obj.netPnl ?? '');
    if (netPnl === '0.00') summary.trainIterationsWithZeroNetPnl += 1;

    const reason = String(obj.reason ?? 'none');
    summary.iterationReasons[reason] = (summary.iterationReasons[reason] ?? 0) + 1;
  }

  if (message === 'rl retrain completed') {
    summary.rlRetrainCount += 1;
    if (obj.promoted === true) summary.rlPromotedCount += 1;
    const reason = String(obj.reason ?? 'none');
    summary.rlReasons[reason] = (summary.rlReasons[reason] ?? 0) + 1;

    const inSampleNetPnl = asNumber(obj.inSampleNetPnl);
    if (inSampleNetPnl === 0) summary.rlInSampleNetPnl.zero += 1;
    else if (inSampleNetPnl && inSampleNetPnl > 0) summary.rlInSampleNetPnl.positive += 1;
    else if (inSampleNetPnl && inSampleNetPnl < 0) summary.rlInSampleNetPnl.negative += 1;

    const paperTrades = asNumber(obj.paperTrades);
    if (paperTrades !== null) {
      summary.paperTrades.min = Math.min(summary.paperTrades.min, paperTrades);
      summary.paperTrades.max = Math.max(summary.paperTrades.max, paperTrades);
      if (paperTrades === 0) summary.paperTrades.zeroCount += 1;
    }
  }

  if (message === 'supervised retrain completed') {
    summary.supervisedRetrainCount += 1;
    if (obj.promoted === true) summary.supervisedPromotedCount += 1;
    const reason = String(obj.reason ?? 'none');
    summary.supervisedReasons[reason] = (summary.supervisedReasons[reason] ?? 0) + 1;

    const paperTrades = asNumber(obj.paperTrades);
    if (paperTrades !== null) {
      summary.paperTrades.min = Math.min(summary.paperTrades.min, paperTrades);
      summary.paperTrades.max = Math.max(summary.paperTrades.max, paperTrades);
      if (paperTrades === 0) summary.paperTrades.zeroCount += 1;
    }
  }
}

if (summary.paperTrades.min === Number.POSITIVE_INFINITY) summary.paperTrades.min = null;
if (summary.paperTrades.max === Number.NEGATIVE_INFINITY) summary.paperTrades.max = null;

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
