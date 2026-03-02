import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const screeningEnv = {
  MARKET_MODE: 'mock',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  MOCK_CLOCK_OFFSET_MINUTES: '7200',
  TARGET_TRADES: '5',
  POLL_MS: '2000',
  MAX_WAIT_MS: '180000',
  USE_EXISTING_RUNTIME: '0',
  RL_CONFIDENCE_GATE_ENABLED: 'true',
};

const smokeEnv = {
  MARKET_MODE: 'mock',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  MOCK_CLOCK_OFFSET_MINUTES: '7200',
  TARGET_TRADES: '100',
  POLL_MS: '5000',
  MAX_WAIT_MS: '7200000',
  USE_EXISTING_RUNTIME: '0',
  RL_CONFIDENCE_GATE_ENABLED: 'true',
};
const expectedTargetTrades = Number(smokeEnv.TARGET_TRADES ?? 100);

const grid = {
  qGap: [0.006, 0.007, 0.008, 0.009],
  minHold: [5, 8, 12],
  flipCooldown: [8, 12],
};

const fmt = value => String(value).replace('.', 'p');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const runOne = (env, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['debug/run-shadow-until-trades.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    resolve({ code: null, signal: 'SIGTERM', timedOut: true });
  }, timeoutMs);

  child.on('error', error => {
    clearTimeout(timer);
    reject(error);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, timedOut: false });
  });
});

const summarizeReport = async reportPath => {
  const raw = await readFile(reportPath, 'utf8');
  const data = JSON.parse(raw);
  const guard = data.guardBlocks ?? {};
  const kpi = data.gate?.kpi ?? {};
  return {
    reportPath,
    reachedTarget: data.reachedTarget ?? null,
    gateReason: data.gate?.reason ?? null,
    paperSanityPassed: data.paperSanity?.passed ?? null,
    tradesPerMinute: kpi.tradesPerMinute ?? null,
    profitFactor: kpi.profitFactor ?? null,
    netPnlUsd: kpi.netPnlUsd ?? null,
    maxDrawdownPct: kpi.maxDrawdownPct ?? null,
    guardBlocks: {
      confidence: guard.confidence ?? null,
      minHold: guard.minHold ?? null,
      flipCooldown: guard.flipCooldown ?? null,
      total: guard.total ?? null,
      confidenceTriggered: guard.confidenceTriggered ?? null,
      actionsBeforeGuards: guard.actionsBeforeGuards ?? null,
      actionsAfterGuards: guard.actionsAfterGuards ?? null,
    },
    qGapStats: data.final?.rlQGapStats ?? null,
  };
};

const table = rows => {
  const header = [
    'qGap',
    'minHold',
    'flipCd',
    'reached',
    'gate',
    'paperOk',
    'tpm',
    'expectedMinutesTo100',
    'timeoutMinutes',
    'PF',
    'netPnl',
    'maxDD',
    'conf',
    'minHoldBl',
    'flipCdBl',
    'totalBl',
  ];
  const fmtNum = (value, digits = 3) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toFixed(digits) : '';
    }
    return String(value);
  };
  const lines = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    const guard = row.guardBlocks || {};
    lines.push(`| ${[
      fmtNum(row.qGap, 3),
      fmtNum(row.minHold, 0),
      fmtNum(row.flipCooldown, 0),
      row.reachedTarget ?? '',
      row.gateReason ?? '',
      row.paperSanityPassed ?? '',
      fmtNum(row.tradesPerMinute, 3),
      fmtNum(row.expectedMinutesTo100, 1),
      fmtNum(row.timeoutMinutes, 1),
      fmtNum(row.profitFactor, 3),
      fmtNum(row.netPnlUsd, 3),
      fmtNum(row.maxDrawdownPct, 3),
      fmtNum(guard.confidence, 0),
      fmtNum(guard.minHold, 0),
      fmtNum(guard.flipCooldown, 0),
      fmtNum(guard.total, 0),
    ].join(' | ')} |`);
  }
  return lines.join('\n');
};

const scoreRow = row => {
  const pf = Number(row.profitFactor ?? 0);
  const net = Number(row.netPnlUsd ?? 0);
  const dd = Number(row.maxDrawdownPct ?? 0);
  return [pf, net, -dd];
};

const pickTop = rows => {
  const usable = rows.filter(row =>
    row.error === null
    && row.paperSanityPassed === true
    && Number(row.tradesPerMinute ?? 0) >= 0.2,
  );
  const sorted = [...usable].sort((a, b) => {
    const [pfA, netA, ddA] = scoreRow(a);
    const [pfB, netB, ddB] = scoreRow(b);
    if (pfB !== pfA) return pfB - pfA;
    if (netB !== netA) return netB - netA;
    return ddB - ddA;
  });
  if (sorted.length >= 3) return sorted.slice(0, 3);

  const fallback = rows.filter(row => row.error === null).sort((a, b) => {
    const tA = Number(a.tradesPerMinute ?? 0);
    const tB = Number(b.tradesPerMinute ?? 0);
    if (tB !== tA) return tB - tA;
    const [pfA, netA, ddA] = scoreRow(a);
    const [pfB, netB, ddB] = scoreRow(b);
    if (pfB !== pfA) return pfB - pfA;
    if (netB !== netA) return netB - netA;
    return ddB - ddA;
  });
  return fallback.slice(0, 3);
};

const runStage = async (stageName, baseEnv, configs) => {
  const targetTrades = Number(baseEnv.TARGET_TRADES ?? expectedTargetTrades);
  const baseTimeoutMinutes = Number(baseEnv.MAX_WAIT_MS ?? 0) / 60000;
  const summary = [];
  for (const config of configs) {
    const { qGap, minHold, flipCooldown } = config;
    const screeningTpm = Number(config.screeningTradesPerMinute ?? config.tradesPerMinute ?? null);
    const reportPath = `debug/shadow-report-${stageName}-q${fmt(qGap)}-h${minHold}-f${flipCooldown}.json`;
    const env = {
      ...process.env,
      ...baseEnv,
      RL_CONFIDENCE_Q_GAP: String(qGap),
      RL_MIN_HOLD_BARS: String(minHold),
      RL_FLIP_COOLDOWN_BARS: String(flipCooldown),
      REPORT_PATH: reportPath,
    };

    let expectedMinutesTo100 = null;
    let timeoutMinutes = baseTimeoutMinutes;
    if (stageName === 'smoke' && Number.isFinite(screeningTpm) && screeningTpm > 0) {
      expectedMinutesTo100 = expectedTargetTrades / screeningTpm;
      timeoutMinutes = Math.min(120, expectedMinutesTo100 * 1.4);
      env.MAX_WAIT_MS = String(Math.round(timeoutMinutes * 60_000));
    } else if (stageName === 'screening') {
      timeoutMinutes = baseTimeoutMinutes;
    }

    const timeoutMs = Number(env.MAX_WAIT_MS) + 45_000;
    await runOne(env, timeoutMs);

    let row = {
      qGap,
      minHold,
      flipCooldown,
      reportPath,
      screeningTradesPerMinute: Number.isFinite(screeningTpm) ? screeningTpm : null,
      expectedMinutesTo100,
      timeoutMinutes,
      error: null,
    };
    try {
      const reportSummary = await summarizeReport(reportPath);
      row = { ...row, ...reportSummary };
    } catch (error) {
      row.error = String(error);
    }

    if (stageName === 'screening' && Number.isFinite(row.tradesPerMinute) && row.tradesPerMinute > 0) {
      row.expectedMinutesTo100 = expectedTargetTrades / row.tradesPerMinute;
      row.screeningTradesPerMinute = row.tradesPerMinute;
    }
    if (!Number.isFinite(row.timeoutMinutes)) {
      row.timeoutMinutes = baseTimeoutMinutes;
    }

    summary.push(row);
    await sleep(1500);
  }
  await writeFile(`debug/shadow-report-${stageName}-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`${stageName.toUpperCase()}_SUMMARY ${JSON.stringify(summary)}`);
  console.log(`${stageName.toUpperCase()}_TABLE\n${table(summary)}`);
  return summary;
};

const runGrid = async () => {
  const configs = [];
  for (const qGap of grid.qGap) {
    for (const minHold of grid.minHold) {
      for (const flipCooldown of grid.flipCooldown) {
        configs.push({ qGap, minHold, flipCooldown });
      }
    }
  }

  const screening = await runStage('screening', screeningEnv, configs);
  const top = pickTop(screening);
  await writeFile('debug/shadow-report-screening-top3.json', JSON.stringify(top, null, 2), 'utf8');
  console.log(`TOP3 ${JSON.stringify(top)}`);

  if (top.length === 0) {
    console.log('No viable configs for KPI smoke. Skipping.');
    return;
  }

  const smoke = await runStage('smoke', smokeEnv, top);
  await writeFile('debug/shadow-report-smoke-top3.json', JSON.stringify(smoke, null, 2), 'utf8');
};

runGrid().catch(error => {
  console.error(String(error));
  process.exit(1);
});
