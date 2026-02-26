import { spawn } from 'node:child_process';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const parseFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const applyMockGateDefaults = () => {
  const mode = String(process.env.MARKET_MODE ?? 'mock').toLowerCase();
  const rollout = String(process.env.ROLLOUT_MODE ?? 'paper').toLowerCase();
  const paperOnly = String(process.env.PAPER_ONLY ?? 'true').toLowerCase() !== 'false';
  const isMockPaper = mode === 'mock' && rollout === 'paper' && paperOnly;
  return {
    isMockPaper,
    defaultsApplied: false,
    effective: {
      minWfSharpe: parseFiniteNumber(process.env.MIN_WF_SHARPE, Number.NaN),
      minWfProfitFactor: parseFiniteNumber(process.env.MIN_WF_PROFIT_FACTOR, Number.NaN),
      minPaperProfitFactor: parseFiniteNumber(process.env.MIN_PAPER_PROFIT_FACTOR, Number.NaN),
      minPaperSharpe: parseFiniteNumber(process.env.MIN_PAPER_SHARPE, Number.NaN),
      minPaperTrades: parseFiniteNumber(process.env.MIN_PAPER_TRADES, Number.NaN),
    },
  };
};

const gateDefaults = applyMockGateDefaults();

const TARGET_WIN_RATE = Number(process.env.TARGET_WIN_RATE ?? '0.5');
const TARGET_NET_PNL = Number(process.env.TARGET_NET_PNL ?? '0');
const TARGET_PROMOTED_ONLY = (process.env.TARGET_PROMOTED_ONLY ?? '1') !== '0';
const MAX_ITERS = Number(process.env.MAX_ITERS ?? '300');
const SLEEP_BETWEEN_ITERS_MS = Number(process.env.SLEEP_BETWEEN_ITERS_MS ?? '30000');
const WARMUP_MS = Number(process.env.WARMUP_MS ?? '20000');

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
const USE_EXISTING_RUNTIME = (process.env.USE_EXISTING_RUNTIME ?? '0') === '1';
const FORCE_NEW_RUNTIME = (process.env.FORCE_NEW_RUNTIME ?? '0') === '1';

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? '120000');
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES ?? '3');
const FETCH_RETRY_BASE_MS = Number(process.env.FETCH_RETRY_BASE_MS ?? '500');
const FETCH_RETRY_MAX_MS = Number(process.env.FETCH_RETRY_MAX_MS ?? '10000');
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? '5000');
const REGISTRY_TIMEOUT_MS = Number(process.env.REGISTRY_TIMEOUT_MS ?? '20000');
const RETRAIN_TIMEOUT_MS = Number(process.env.RETRAIN_TIMEOUT_MS ?? String(20 * 60 * 1000));
const POST_RETRIES = Number(process.env.FETCH_POST_RETRIES ?? '1');

const shouldRetryStatus = status => status === 408 || status === 429 || status >= 500;
const calcBackoff = attempt =>
  Math.min(FETCH_RETRY_MAX_MS, FETCH_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
const withJitter = value => Math.round(value * (0.9 + Math.random() * 0.2));

const isRetryableError = error => {
  const msg = String(error ?? '').toLowerCase();
  return (
    msg.includes('fetch failed')
    || msg.includes('econn')
    || msg.includes('etimedout')
    || msg.includes('socket')
  );
};

const fetchJson = async (path, options = {}) => {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retries = options.retries ?? FETCH_RETRIES;
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${BASE_URL}${path}`, { method, signal: controller.signal });
      if (!res.ok) {
        if (attempt < maxAttempts && shouldRetryStatus(res.status)) {
          const backoffMs = withJitter(calcBackoff(attempt));
          console.log(
            JSON.stringify({
              level: 'warn',
              message: 'fetch retry',
              method,
              path,
              attempt,
              maxAttempts,
              reason: `status ${res.status}`,
              backoffMs,
            }),
          );
          await wait(backoffMs);
          continue;
        }
        throw new Error(`${method} ${path} failed: ${res.status}`);
      }
      return res.json();
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      const retryable = isAbort || isRetryableError(error);
      if (attempt < maxAttempts && retryable) {
        const backoffMs = withJitter(calcBackoff(attempt));
        console.log(
          JSON.stringify({
            level: 'warn',
            message: 'fetch retry',
            method,
            path,
            attempt,
            maxAttempts,
            reason: isAbort ? 'timeout' : String(error),
            backoffMs,
          }),
        );
        await wait(backoffMs);
        continue;
      }
      throw new Error(`${method} ${path} failed${isAbort ? ' (timeout)' : ''}: ${error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`${method} ${path} failed: exhausted retries`);
};

const get = async (path, options = {}) =>
  fetchJson(path, { method: 'GET', timeoutMs: options.timeoutMs, retries: options.retries });

const post = async (path, options = {}) =>
  fetchJson(path, { method: 'POST', timeoutMs: options.timeoutMs, retries: options.retries });

const pickLatestRlModel = registry => {
  const champ = registry?.champion;
  const challengers = Array.isArray(registry?.challengers) ? registry.challengers : [];
  const all = [
    ...(champ && champ.kind === 'rl_linear_q' ? [champ] : []),
    ...challengers.filter(item => item?.kind === 'rl_linear_q'),
  ];
  if (all.length === 0) return null;
  all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return all[0];
};

const startRuntime = () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
};

const probeHealth = async () => {
  try {
    const health = await get('/health', { timeoutMs: HEALTH_TIMEOUT_MS, retries: 0 });
    return health?.status === 'ok';
  } catch {
    return false;
  }
};

const ensureHealthy = async () => {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const health = await get('/health', { timeoutMs: HEALTH_TIMEOUT_MS, retries: 0 });
      if (health?.status === 'ok') return;
    } catch {
      // wait and retry
    }
    await wait(500);
  }
  throw new Error('runtime did not become healthy');
};

const fmtPct = value => `${(Number(value) * 100).toFixed(2)}%`;
const fmtNum = value => Number(value).toFixed(2);

const toFiniteOrNull = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickBestLeg = legs => {
  if (legs.length === 0) return null;
  const scoreWin = leg => (Number.isFinite(leg.winRate) ? leg.winRate : Number.NEGATIVE_INFINITY);
  const scorePnl = leg => (Number.isFinite(leg.netPnl) ? leg.netPnl : Number.NEGATIVE_INFINITY);

  return [...legs].sort((a, b) => {
    const winDiff = scoreWin(b) - scoreWin(a);
    if (winDiff !== 0) return winDiff;
    const pnlDiff = scorePnl(b) - scorePnl(a);
    if (pnlDiff !== 0) return pnlDiff;
    return Number(b.kind === 'rl') - Number(a.kind === 'rl');
  })[0];
};

const isSnapshotBetter = (next, current) => {
  if (!current) return true;
  const nextWin = Number.isFinite(next.winRate) ? next.winRate : Number.NEGATIVE_INFINITY;
  const curWin = Number.isFinite(current.winRate) ? current.winRate : Number.NEGATIVE_INFINITY;
  if (nextWin !== curWin) return nextWin > curWin;
  const nextPnl = Number.isFinite(next.netPnl) ? next.netPnl : Number.NEGATIVE_INFINITY;
  const curPnl = Number.isFinite(current.netPnl) ? current.netPnl : Number.NEGATIVE_INFINITY;
  return nextPnl > curPnl;
};

const main = async () => {
  let runtime = null;
  let ownsRuntime = false;
  let best = null;
  let last = null;
  let success = false;
  let promotedEver = false;
  let firstTargetHit = null;
  let firstLegacyThresholdHit = null;
  let firstPromoted = null;

  try {
    const hasRunningRuntime = await probeHealth();
    if (!FORCE_NEW_RUNTIME && (USE_EXISTING_RUNTIME || hasRunningRuntime)) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'using existing runtime',
          baseUrl: BASE_URL,
        }),
      );
    } else {
      runtime = startRuntime();
      ownsRuntime = true;
      await ensureHealthy();
    }

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'train-until-target started',
        targetWinRate: TARGET_WIN_RATE,
        targetNetPnl: TARGET_NET_PNL,
        targetPromotedOnly: TARGET_PROMOTED_ONLY,
        forceNewRuntime: FORCE_NEW_RUNTIME,
        maxIters: MAX_ITERS,
        sleepBetweenItersMs: SLEEP_BETWEEN_ITERS_MS,
        warmupMs: WARMUP_MS,
        gateDefaults,
      }),
    );

    if (WARMUP_MS > 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'train warmup',
          warmupMs: WARMUP_MS,
        }),
      );
      await wait(WARMUP_MS);
    }

    for (let iter = 1; iter <= MAX_ITERS; iter += 1) {
      const retrain = await post('/ml/retrain', { timeoutMs: RETRAIN_TIMEOUT_MS, retries: POST_RETRIES });
      const registry = await get('/ml/registry', { timeoutMs: REGISTRY_TIMEOUT_MS });
      const latestRl = pickLatestRlModel(registry);

      const supervised = retrain?.supervised ?? {};
      const rl = retrain?.rl ?? {};
      const rlScorecard = rl?.scorecard ?? null;
      const rlScoreMetrics = rlScorecard?.metrics ?? null;

      const retrainWinRateRaw = rlScoreMetrics?.inSample?.winRate ?? rl?.inSample?.winRate;
      const retrainWinRate = Number.isFinite(Number(retrainWinRateRaw)) ? Number(retrainWinRateRaw) : null;
      const retrainNetPnlRaw = rlScoreMetrics?.inSample?.netPnl ?? rl?.inSample?.netPnl;
      const retrainNetPnl = Number.isFinite(Number(retrainNetPnlRaw)) ? Number(retrainNetPnlRaw) : null;
      const retrainScoreReason = rlScorecard?.reason ?? null;
      const retrainScoreThresholds = rlScorecard?.thresholds ?? null;

      const fallbackWinRate = Number(latestRl?.evaluation?.inSampleWinRate ?? latestRl?.metrics?.accuracy ?? 0);
      const fallbackNetPnl = Number(latestRl?.evaluation?.inSampleNetPnl ?? Number.NEGATIVE_INFINITY);

      const rlAttempted = Boolean(rl?.attempted);
      const rlPromoted = Boolean(rl?.promoted);
      const rlStaleMetrics = !rlAttempted && retrainWinRate === null && retrainNetPnl === null;
      const rlScorecardMissingOnAttempt = rlAttempted && !rlScorecard;
      const rlLeg = {
        kind: 'rl',
        attempted: rlAttempted,
        promoted: rlPromoted,
        winRate: rlStaleMetrics ? null : (retrainWinRate ?? fallbackWinRate),
        netPnl: rlStaleMetrics ? null : (retrainNetPnl ?? fallbackNetPnl),
        staleMetrics: rlStaleMetrics,
        metricSource: rlStaleMetrics
          ? 'stale'
          : (retrainWinRate !== null || retrainNetPnl !== null
            ? (rlScoreMetrics?.inSample ? 'scorecard_retrain' : 'current_retrain')
            : 'registry_fallback'),
        scorecardMissingOnAttempt: rlScorecardMissingOnAttempt,
        gateBasis: rlScorecard
          ? {
              wfSharpe: rlScoreMetrics?.walkForward?.sharpe ?? null,
              wfProfitFactor: rlScoreMetrics?.walkForward?.profitFactor ?? null,
              holdoutTrades: rlScoreMetrics?.holdout?.trades ?? null,
              unseenTrades: rlScoreMetrics?.unseen?.trades ?? null,
            }
          : null,
        challengerId: rl?.challengerId ?? null,
        reason: retrainScoreReason ?? rl?.reason ?? null,
        thresholds: retrainScoreThresholds,
      };

      const supervisedAttempted = Boolean(supervised?.attempted);
      const supervisedPromoted = Boolean(supervised?.promoted);
      const supervisedLeg = {
        kind: 'supervised',
        attempted: supervisedAttempted,
        promoted: supervisedPromoted,
        // supervised returns holdout netPnl but no direct winRate in retrain payload
        winRate: null,
        netPnl: toFiniteOrNull(supervised?.holdout?.netPnl),
        staleMetrics: false,
        metricSource: Number.isFinite(Number(supervised?.holdout?.netPnl)) ? 'supervised_holdout' : 'none',
        challengerId: supervised?.challengerId ?? null,
        reason: supervised?.reason ?? null,
      };

      const promotedLeg = pickBestLeg([supervisedLeg, rlLeg].filter(leg => leg.promoted));
      const attemptedLeg = pickBestLeg([supervisedLeg, rlLeg].filter(leg => leg.attempted));
      const primaryLeg = promotedLeg ?? attemptedLeg ?? rlLeg;

      const promoted = Boolean(supervisedPromoted || rlPromoted);
      const attempted = Boolean(primaryLeg?.attempted || promoted);
      const winRate = primaryLeg?.winRate ?? null;
      const netPnl = primaryLeg?.netPnl ?? null;
      const staleMetrics = Boolean(primaryLeg?.staleMetrics);
      const metricSource = primaryLeg?.metricSource ?? 'none';
      const challengerId = primaryLeg?.challengerId ?? null;
      const reason = primaryLeg?.reason ?? null;
      const promotionSource = promoted
        ? [supervisedPromoted ? 'supervised' : null, rlPromoted ? 'rl' : null].filter(Boolean).join('+')
        : null;

      const snapshot = {
        iter,
        attempted,
        promoted,
        winRate,
        netPnl,
        staleMetrics,
        metricSource,
        challengerId,
        reason,
        sourceKind: primaryLeg?.kind ?? 'rl',
        promotionSource,
        supervisedPromoted,
        rlPromoted,
        scorecardMissingOnAttempt: Boolean(primaryLeg?.scorecardMissingOnAttempt),
        gateBasis: primaryLeg?.gateBasis ?? null,
        thresholds: primaryLeg?.thresholds ?? null,
      };
      last = snapshot;

      if (isSnapshotBetter(snapshot, best)) {
        best = snapshot;
      }

      if (promoted) {
        promotedEver = true;
        if (!firstPromoted) firstPromoted = snapshot;
      }

      console.log(
        JSON.stringify({
          level: 'info',
          message: 'train iteration',
          iter,
          attempted,
          promoted,
          winRate: winRate === null ? null : fmtPct(winRate),
          netPnl: netPnl === null ? null : fmtNum(netPnl),
          staleMetrics,
          metricSource: snapshot.metricSource,
          challengerId: snapshot.challengerId,
          reason: snapshot.reason,
          sourceKind: snapshot.sourceKind,
          promotionSource: snapshot.promotionSource,
          supervisedPromoted: snapshot.supervisedPromoted,
          rlPromoted: snapshot.rlPromoted,
          scorecardMissingOnAttempt: snapshot.scorecardMissingOnAttempt,
          gateBasis: snapshot.gateBasis,
        }),
      );

      const legacyThresholdMet = attempted && winRate >= TARGET_WIN_RATE && netPnl > TARGET_NET_PNL;
      if (legacyThresholdMet && !firstLegacyThresholdHit) {
        firstLegacyThresholdHit = snapshot;
      }

      const reachedTarget = TARGET_PROMOTED_ONLY ? promoted : legacyThresholdMet;
      if (reachedTarget && !firstTargetHit) {
        success = true;
        firstTargetHit = snapshot;
      }

      if (iter < MAX_ITERS) {
        await wait(SLEEP_BETWEEN_ITERS_MS);
      }
    }
  } finally {
    if (runtime && ownsRuntime) {
      runtime.kill('SIGTERM');
      await wait(500);
    }
  }

  if (!success) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'target not reached',
        targetWinRate: TARGET_WIN_RATE,
        targetNetPnl: TARGET_NET_PNL,
        targetPromotedOnly: TARGET_PROMOTED_ONLY,
        firstLegacyThresholdHit,
        firstPromoted,
        promotedEver,
        last,
        best,
      }),
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'target reached after full run',
      targetWinRate: TARGET_WIN_RATE,
      targetNetPnl: TARGET_NET_PNL,
      targetPromotedOnly: TARGET_PROMOTED_ONLY,
      firstLegacyThresholdHit,
      firstTargetHit,
      firstPromoted,
      promotedEver,
      final: last,
      best,
    }),
  );
};

main().catch(error => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'train-until-target failed',
      error: String(error),
    }),
  );
  process.exit(1);
});
