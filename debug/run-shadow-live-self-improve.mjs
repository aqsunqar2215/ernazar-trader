import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const nowTag = () => new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replaceAll('-', '');
const toNum = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const toFinite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const safeDiv = (num, den, eps = 0.0005) => num / Math.max(toFinite(den, 0), eps);

const totalIterations = Math.max(1, Math.floor(toNum(process.env.SELF_IMPROVE_ITERS, 6)));
const seed = toNum(process.env.SELF_IMPROVE_SEED, Date.now() % 2_147_483_647);
const firstIterationResetScoreThreshold = toNum(process.env.SELF_IMPROVE_RESET_IF_FIRST_SCORE_BELOW, -250);
const resetBonusIterations = Math.max(0, Math.floor(toNum(process.env.SELF_IMPROVE_RESET_BONUS_ITERS, 2)));
const minFastWaitMs = Math.max(60_000, Math.floor(toNum(process.env.SELF_IMPROVE_MIN_MAX_WAIT_MS, 150_000)));
const effectiveFastWaitMs = Math.max(minFastWaitMs, Math.floor(toNum(process.env.MAX_WAIT_MS, 120_000)));
const rng = (() => {
  let state = (seed >>> 0) || 123456789;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
})();
const chooseDet = arr => arr[Math.floor(rng() * arr.length)];

const searchSpace = {
  RL_CONFIDENCE_Q_GAP: ['0.008', '0.01', '0.012'],
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_SCALE: ['0.6', '0.7', '0.8'],
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_QUANTILE: ['0.5', '0.55', '0.6'],
  RL_MIN_HOLD_BARS: ['1', '2', '3'],
  RL_FLIP_COOLDOWN_BARS: ['0', '1', '2'],
  RL_MAX_POSITION_BARS: ['4', '6', '8', '10'],
  MAX_ORDERS_PER_MINUTE: ['20', '30', '40'],
  RL_SHADOW_GATE_MIN_NET_PNL_USD: ['-1', '-0.75', '-0.5'],
};

const candidateKeys = Object.keys(searchSpace);

const fixedEnv = {
  MARKET_MODE: process.env.MARKET_MODE ?? 'binance',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  TARGET_TRADES: process.env.TARGET_TRADES ?? '1',
  MAX_WAIT_MS: String(effectiveFastWaitMs),
  POLL_MS: process.env.POLL_MS ?? '3000',
  USE_EXISTING_RUNTIME: '0',
  COOLDOWN_LOSS_STREAK: '0',
  COOLDOWN_LOSS_MINUTES: '0',
  RL_CONFIDENCE_GATE_ENABLED: 'true',
  RL_HOLD_FLATTEN_ENABLED: 'false',
  RL_MIN_SIGNAL_STRENGTH: '0',
  RL_SHADOW_GATE_REQUIRED_TIER: '1',
  RL_SHADOW_GATE_MIN_PF: '0',
  RL_SHADOW_GATE_MAX_DD_PCT: '0.05',
};

const candidateDefaults = {
  RL_CONFIDENCE_Q_GAP: '0.01',
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_SCALE: '0.8',
  RL_CONFIDENCE_Q_GAP_ADAPTIVE_QUANTILE: '0.55',
  RL_MIN_HOLD_BARS: '3',
  RL_FLIP_COOLDOWN_BARS: '1',
  RL_MAX_POSITION_BARS: '6',
  MAX_ORDERS_PER_MINUTE: '40',
  RL_SHADOW_GATE_MIN_NET_PNL_USD: '-0.5',
};

const loadLatestBestCandidate = async () => {
  const stableBestPath = resolve(process.env.SELF_IMPROVE_STABLE_BEST_PATH ?? 'debug/self-improve-stable-best.json');
  try {
    const stablePayload = JSON.parse(await readFile(stableBestPath, 'utf8'));
    const stableCandidate = stablePayload?.candidate ?? null;
    const stablePassed = stablePayload?.summary?.overallPassed ?? stablePayload?.overallPassed ?? false;
    if (stableCandidate && typeof stableCandidate === 'object' && Boolean(stablePassed)) {
      return stableCandidate;
    }
  } catch {
    // Stable best file is optional, fallback to latest self-improve best files.
  }

  const entries = await readdir(resolve('debug')).catch(() => []);
  const candidates = entries
    .filter(name => /^self-improve-best-\d{8}T\d{9}Z\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const payload = JSON.parse(await readFile(resolve('debug', name), 'utf8'));
      const summary = payload?.summary ?? null;
      const isPassed = Boolean(summary?.overallPassed);
      if (!isPassed) continue;
      const candidate = payload?.candidate ?? payload?.summary?.candidate ?? null;
      if (candidate && typeof candidate === 'object') {
        return candidate;
      }
    } catch {
      // try older files until a valid payload is found
    }
  }
  return null;
};

const resolveBaseCandidate = async () => {
  const useLatestBest = (process.env.SELF_IMPROVE_USE_LATEST_BEST ?? '1') !== '0';
  const latestBest = useLatestBest ? await loadLatestBestCandidate() : null;
  const merged = { ...candidateDefaults, ...(latestBest ?? {}) };
  for (const key of candidateKeys) {
    if (process.env[key] !== undefined) {
      merged[key] = String(process.env[key]);
    }
  }
  return merged;
};

const mutateCandidate = current => {
  const next = { ...current };
  const mutations = clamp(Math.floor(rng() * 3) + 1, 1, 3);
  for (let i = 0; i < mutations; i += 1) {
    const key = chooseDet(candidateKeys);
    next[key] = chooseDet(searchSpace[key]);
  }
  return next;
};

const diffCandidate = (fromCandidate, toCandidate) => {
  const from = fromCandidate ?? {};
  const to = toCandidate ?? {};
  const diff = [];
  for (const key of candidateKeys) {
    const prev = from[key];
    const next = to[key];
    if (prev !== next) {
      diff.push({ key, from: prev ?? null, to: next ?? null });
    }
  }
  return diff;
};

const runFast = async ({ iteration, candidate, runTag }) => {
  const reportPath = `debug/shadow-report-self-improve-${runTag}-i${String(iteration).padStart(2, '0')}.json`;
  const metadataPath = `debug/runtime-profile-self-improve-${runTag}-i${String(iteration).padStart(2, '0')}.json`;
  const env = {
    ...process.env,
    ...fixedEnv,
    ...candidate,
    PROFILE_ID: `live-self-improve-${runTag}-i${String(iteration).padStart(2, '0')}`,
    REPORT_PATH: reportPath,
    METADATA_PATH: metadataPath,
  };

  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['debug/run-shadow-live-fast.mjs'], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => resolveRun({ code, signal, reportPath, metadataPath }));
  });

  let report = null;
  let readError = null;
  try {
    report = JSON.parse(await readFile(resolve(reportPath), 'utf8'));
  } catch (error) {
    readError = String(error);
  }
  return { ...result, report, readError, candidate };
};

const scoreResult = run => {
  if (!run.report) return -10_000;
  const report = run.report;
  const paper = report.finalSnapshots?.runtimeStatus?.paperMetrics ?? {};
  const rlNet = toFinite(report.final?.rlNetPnlUsd, 0);
  const rlDd = toFinite(report.final?.rlMaxDrawdownPct, 0);
  const rlPf = clamp(toFinite(report.final?.rlProfitFactor, 0), 0, 20);
  const paperNet = toFinite(paper.netPnlUsd, 0);
  const paperDd = toFinite(paper.maxDrawdownPct, 0);
  const paperPf = clamp(toFinite(paper.profitFactor, 0), 0, 20);
  const rlPnLToDd = clamp(safeDiv(rlNet, rlDd), -200, 200);
  const paperPnLToDd = clamp(safeDiv(paperNet, paperDd), -200, 200);
  const trades = toNum(report.final?.rlTrades, 0);
  const overall = report.overallPassed ? 1 : 0;
  const gate = report.gate?.passed ? 1 : 0;
  const paperSanity = report.paperSanity?.passed ? 1 : 0;

  let score = (
    overall * 1000 +
    gate * 280 +
    paperSanity * 220 +
    Math.min(3, trades) * 24 +
    paperPf * 20 +
    rlPf * 10 +
    paperPnLToDd * 6 +
    rlPnLToDd * 4 +
    paperNet * 40 +
    rlNet * 20 -
    paperDd * 300 -
    rlDd * 180
  );

  // Make failed runs explicitly unattractive so first-iteration reset can trigger.
  if (!overall) score -= 900;
  if (!gate) score -= 300;
  if (!paperSanity) score -= 250;

  return score;
};

const compactSummary = (run, score) => {
  const report = run.report ?? {};
  const paper = report.finalSnapshots?.runtimeStatus?.paperMetrics ?? {};
  const rl = report.final ?? {};
  return {
    iteration: run.iteration,
    score,
    exitCode: run.code,
    overallPassed: Boolean(report.overallPassed),
    gatePassed: Boolean(report.gate?.passed),
    paperSanityPassed: Boolean(report.paperSanity?.passed),
    rlTrades: toNum(rl.rlTrades, 0),
    rlNetPnlUsd: toNum(rl.rlNetPnlUsd, 0),
    rlMaxDrawdownPct: toNum(rl.rlMaxDrawdownPct, 0),
    paperNetPnlUsd: toNum(paper.netPnlUsd, 0),
    paperMaxDrawdownPct: toNum(paper.maxDrawdownPct, 0),
    candidate: run.candidate,
    mutation: run.mutation ?? null,
    reportPath: run.reportPath,
    readError: run.readError,
  };
};

const run = async () => {
  await mkdir(resolve('debug'), { recursive: true });
  const runTag = nowTag();
  const useLatestBest = (process.env.SELF_IMPROVE_USE_LATEST_BEST ?? '1') !== '0';
  const baseCandidate = await resolveBaseCandidate();
  const hardResetCandidate = { ...candidateDefaults };
  for (const key of candidateKeys) {
    if (process.env[key] !== undefined) {
      hardResetCandidate[key] = String(process.env[key]);
    }
  }
  const history = [];
  let best = null;
  let candidate = { ...baseCandidate };
  let scheduledIterations = totalIterations;
  let resetTriggered = false;

  process.stdout.write(`SELF_IMPROVE_START ${JSON.stringify({
    runTag,
    totalIterations,
    resetBonusIterations,
    scheduledIterations,
    seed,
    firstIterationResetScoreThreshold,
    useLatestBest,
    baseCandidate,
  })}\n`);

  for (let i = 1; i <= scheduledIterations; i += 1) {
    let mutation = {
      source: i === 1 ? 'seed' : (best ? 'best' : 'previous'),
      changedKeys: [],
      diff: [],
    };
    if (i > 1) {
      const source = best ? best.candidate : candidate;
      const nextCandidate = mutateCandidate(source);
      const diff = diffCandidate(source, nextCandidate);
      candidate = nextCandidate;
      mutation = {
        source: best ? 'best' : 'previous',
        changedKeys: diff.map(item => item.key),
        diff,
      };
    }

    let runResult;
    try {
      runResult = await runFast({ iteration: i, candidate, runTag });
    } catch (error) {
      const failSummary = {
        iteration: i,
        score: -10_000,
        exitCode: -1,
        overallPassed: false,
        gatePassed: false,
        paperSanityPassed: false,
        rlTrades: 0,
        rlNetPnlUsd: 0,
        rlMaxDrawdownPct: 0,
        paperNetPnlUsd: 0,
        paperMaxDrawdownPct: 0,
        candidate: { ...candidate },
        mutation,
        reportPath: null,
        readError: String(error),
      };
      history.push(failSummary);
      process.stdout.write(`SELF_IMPROVE_ITER_ERROR ${JSON.stringify(failSummary)}\n`);
      continue;
    }
    runResult.iteration = i;
    runResult.mutation = mutation;
    const score = scoreResult(runResult);
    const summary = compactSummary(runResult, score);
    history.push(summary);
    process.stdout.write(`SELF_IMPROVE_ITER ${JSON.stringify(summary)}\n`);

    if (
      i === 1 &&
      useLatestBest &&
      !resetTriggered &&
      score < firstIterationResetScoreThreshold
    ) {
      resetTriggered = true;
      best = null;
      candidate = { ...hardResetCandidate };
      const prevScheduledIterations = scheduledIterations;
      scheduledIterations += resetBonusIterations;
      process.stdout.write(`SELF_IMPROVE_RESET ${JSON.stringify({
        reason: 'first_iteration_score_below_threshold',
        threshold: firstIterationResetScoreThreshold,
        observedScore: score,
        prevScheduledIterations,
        scheduledIterations,
        resetCandidate: candidate,
      })}\n`);
      continue;
    }

    if (!best || score > best.score) {
      best = {
        score,
        candidate: { ...candidate },
        summary,
      };
      process.stdout.write(`SELF_IMPROVE_BEST ${JSON.stringify(best.summary)}\n`);
    }
  }

  const out = {
    runTag,
    totalIterations,
    resetBonusIterations,
    scheduledIterations,
    seed,
    fixedEnv,
    baseCandidate,
    best: best?.summary?.overallPassed ? best.summary : null,
    history,
  };

  const summaryPath = `debug/self-improve-summary-${runTag}.json`;
  const bestPath = `debug/self-improve-best-${runTag}.json`;
  const persistedBest = best?.summary?.overallPassed ? best : null;
  await writeFile(resolve(summaryPath), JSON.stringify(out, null, 2), 'utf8');
  await writeFile(resolve(bestPath), JSON.stringify(persistedBest, null, 2), 'utf8');

  process.stdout.write(`SELF_IMPROVE_DONE ${JSON.stringify({
    summaryPath,
    bestPath,
    best: persistedBest?.summary ?? null,
  })}\n`);

  if (!persistedBest?.summary?.overallPassed) {
    process.exitCode = 2;
  }
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
