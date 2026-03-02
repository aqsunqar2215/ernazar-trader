import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const toNum = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nowIso = () => new Date().toISOString();
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

const batchIterations = Math.max(1, Math.floor(toNum(process.env.SELF_IMPROVE_BATCH_ITERS, 12)));
const maxCycles = Math.max(0, Math.floor(toNum(process.env.SELF_IMPROVE_MAX_CYCLES, 0)));
const cycleSleepMs = Math.max(0, Math.floor(toNum(process.env.SELF_IMPROVE_CYCLE_SLEEP_MS, 5000)));
const minTradesForStable = Math.max(0, Math.floor(toNum(process.env.SELF_IMPROVE_MIN_TRADES_FOR_STABLE, 1)));
const minScoreDelta = toNum(process.env.SELF_IMPROVE_MIN_SCORE_DELTA, 0);

const stableBestPath = resolve(process.env.SELF_IMPROVE_STABLE_BEST_PATH ?? 'debug/self-improve-stable-best.json');
const continuousReportPath = resolve(process.env.SELF_IMPROVE_CONTINUOUS_REPORT_PATH ?? 'debug/self-improve-continuous-latest.json');

const readJson = async path => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

const parseTaggedJson = (line, prefix) => {
  if (!line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
};

const runCycle = async cycle => {
  const env = {
    ...process.env,
    SELF_IMPROVE_ITERS: String(batchIterations),
    SELF_IMPROVE_STABLE_BEST_PATH: stableBestPath,
  };

  let startPayload = null;
  let donePayload = null;
  let stdoutBuffer = '';

  const child = spawn(process.execPath, ['debug/run-shadow-live-self-improve.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const parseLine = rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    const start = parseTaggedJson(line, 'SELF_IMPROVE_START ');
    if (start) startPayload = start;
    const done = parseTaggedJson(line, 'SELF_IMPROVE_DONE ');
    if (done) donePayload = done;
  };

  const consumeStdout = chunk => {
    const text = chunk.toString('utf8');
    process.stdout.write(text);

    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      parseLine(rawLine);
    }
  };

  child.stdout.on('data', consumeStdout);
  child.stdout.on('end', () => {
    if (stdoutBuffer.length > 0) {
      parseLine(stdoutBuffer);
      stdoutBuffer = '';
    }
  });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk.toString('utf8'));
  });

  const exitCode = await new Promise(resolveExit => {
    child.on('exit', code => resolveExit(code ?? 1));
  });

  const summaryPath = donePayload?.summaryPath
    ? resolve(donePayload.summaryPath)
    : startPayload?.runTag
      ? resolve(`debug/self-improve-summary-${startPayload.runTag}.json`)
      : null;
  const summary = summaryPath ? await readJson(summaryPath) : null;

  return {
    cycle,
    exitCode,
    startPayload,
    donePayload,
    summaryPath,
    summary,
  };
};

const isStableCandidate = item => {
  if (!item) return false;
  if (!item.overallPassed || !item.gatePassed || !item.paperSanityPassed) return false;
  const trades = toNum(item.rlTrades, 0);
  return trades >= minTradesForStable;
};

const pickCycleBest = summary => {
  const history = Array.isArray(summary?.history) ? summary.history : [];
  const eligible = history.filter(isStableCandidate);
  if (eligible.length === 0) return null;
  const sorted = eligible
    .map(item => ({ ...item, score: toNum(item.score, -10_000) }))
    .sort((a, b) => b.score - a.score);
  return sorted[0];
};

const run = async () => {
  await mkdir(resolve('debug'), { recursive: true });

  let stopRequested = false;
  process.on('SIGINT', () => {
    stopRequested = true;
    process.stdout.write('SELF_IMPROVE_CONTINUOUS_STOP_REQUESTED {"signal":"SIGINT"}\n');
  });

  const state = {
    startedAt: nowIso(),
    batchIterations,
    maxCycles,
    cycleSleepMs,
    minTradesForStable,
    minScoreDelta,
    stableBestPath,
    cycles: [],
    stableBest: await readJson(stableBestPath),
  };

  process.stdout.write(`SELF_IMPROVE_CONTINUOUS_START ${JSON.stringify({
    startedAt: state.startedAt,
    batchIterations,
    maxCycles,
    cycleSleepMs,
    minTradesForStable,
    minScoreDelta,
    stableBestPath,
  })}\n`);

  for (let cycle = 1; !stopRequested && (maxCycles === 0 || cycle <= maxCycles); cycle += 1) {
    process.stdout.write(`SELF_IMPROVE_CONTINUOUS_CYCLE_START ${JSON.stringify({ cycle, at: nowIso() })}\n`);

    const cycleResult = await runCycle(cycle);
    const cycleBest = pickCycleBest(cycleResult.summary);

    const currentStableScore = toNum(state.stableBest?.score, Number.NEGATIVE_INFINITY);
    const candidateScore = toNum(cycleBest?.score, Number.NEGATIVE_INFINITY);
    const improvesStable = cycleBest && (candidateScore > currentStableScore + minScoreDelta);

    if (improvesStable) {
      state.stableBest = {
        score: candidateScore,
        candidate: cycleBest.candidate,
        summary: cycleBest,
        overallPassed: true,
        source: {
          cycle,
          summaryPath: cycleResult.summaryPath ?? null,
          runTag: cycleResult.summary?.runTag ?? cycleResult.startPayload?.runTag ?? null,
        },
        updatedAt: nowIso(),
      };
      await writeFile(stableBestPath, JSON.stringify(state.stableBest, null, 2), 'utf8');
      process.stdout.write(`SELF_IMPROVE_CONTINUOUS_STABLE_UPDATE ${JSON.stringify({
        cycle,
        score: candidateScore,
        candidate: cycleBest.candidate,
      })}\n`);
    } else {
      process.stdout.write(`SELF_IMPROVE_CONTINUOUS_STABLE_KEEP ${JSON.stringify({
        cycle,
        cycleBestScore: cycleBest ? candidateScore : null,
        stableScore: Number.isFinite(currentStableScore) ? currentStableScore : null,
      })}\n`);
    }

    const cycleRecord = {
      cycle,
      at: nowIso(),
      exitCode: cycleResult.exitCode,
      runTag: cycleResult.summary?.runTag ?? cycleResult.startPayload?.runTag ?? null,
      summaryPath: cycleResult.summaryPath ?? null,
      cycleBest: cycleBest ?? null,
      stableScore: toNum(state.stableBest?.score, null),
    };
    state.cycles.push(cycleRecord);
    state.lastUpdatedAt = nowIso();
    await writeFile(continuousReportPath, JSON.stringify(state, null, 2), 'utf8');

    process.stdout.write(`SELF_IMPROVE_CONTINUOUS_CYCLE_DONE ${JSON.stringify(cycleRecord)}\n`);

    if (!stopRequested && (maxCycles === 0 || cycle < maxCycles) && cycleSleepMs > 0) {
      await wait(cycleSleepMs);
    }
  }

  process.stdout.write(`SELF_IMPROVE_CONTINUOUS_DONE ${JSON.stringify({
    finishedAt: nowIso(),
    cyclesCompleted: state.cycles.length,
    stableScore: toNum(state.stableBest?.score, null),
    stableBestPath,
    continuousReportPath,
  })}\n`);
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
