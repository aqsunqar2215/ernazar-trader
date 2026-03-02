import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const nowTag = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PIPELINE_ID = process.env.PIPELINE_ID || `index1-e2e-${nowTag()}`;
const PAPER_DURATION_HOURS = Number(process.env.PAPER_DURATION_HOURS || 4);
const PAPER_DURATION_MS = Math.max(1, PAPER_DURATION_HOURS) * 60 * 60 * 1000;
const BASELINE_STATUS_PATH =
  process.env.BASELINE_STATUS_PATH || 'debug/live-paper-status-rerun-2026-03-01T19-50-43-790Z.jsonl';
const TINY_LIVE_NOTIONAL = String(process.env.TINY_LIVE_NOTIONAL_USD || 10);
const COOLDOWN_LOSS_STREAK = process.env.COOLDOWN_LOSS_STREAK || '3';
const COOLDOWN_LOSS_MINUTES = process.env.COOLDOWN_LOSS_MINUTES || '15';
const RL_CONFIDENCE_GATE_ENABLED = process.env.RL_CONFIDENCE_GATE_ENABLED || 'true';
const RL_CONFIDENCE_Q_GAP = process.env.RL_CONFIDENCE_Q_GAP || '0.0015';
const RL_MIN_HOLD_BARS = process.env.RL_MIN_HOLD_BARS || '30';
const RL_FLIP_COOLDOWN_BARS = process.env.RL_FLIP_COOLDOWN_BARS || '45';

const logPath = path.join(ROOT, 'debug', `index1-e2e-${PIPELINE_ID}.log`);
const finalPath = path.join(ROOT, 'debug', `index1-e2e-final-${PIPELINE_ID}.json`);

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });

const log = (step, message, extra = {}) => {
  const row = { ts: new Date().toISOString(), pipelineId: PIPELINE_ID, step, message, ...extra };
  fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
};

const runNode = (script, args = [], env = {}) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });

const parseLastJsonLine = text => {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  return null;
};

const updateEnvForTinyLive = () => {
  const envPath = path.join(ROOT, '.env');
  const backupPath = path.join(ROOT, 'debug', `env-backup-before-tiny-live-${PIPELINE_ID}.env`);
  const current = fs.readFileSync(envPath, 'utf8');
  fs.writeFileSync(backupPath, current);
  const patch = [
    '',
    `# index1 tiny-live autopromote ${PIPELINE_ID}`,
    'MARKET_MODE=binance',
    'PAPER_ONLY=false',
    'ROLLOUT_MODE=tiny_live',
    'ENABLE_LIVE_ORDERS=true',
    `TINY_LIVE_MAX_NOTIONAL_USD=${TINY_LIVE_NOTIONAL}`,
    `COOLDOWN_LOSS_STREAK=${COOLDOWN_LOSS_STREAK}`,
    `COOLDOWN_LOSS_MINUTES=${COOLDOWN_LOSS_MINUTES}`,
    `RL_CONFIDENCE_GATE_ENABLED=${RL_CONFIDENCE_GATE_ENABLED}`,
    `RL_CONFIDENCE_Q_GAP=${RL_CONFIDENCE_Q_GAP}`,
    `RL_MIN_HOLD_BARS=${RL_MIN_HOLD_BARS}`,
    `RL_FLIP_COOLDOWN_BARS=${RL_FLIP_COOLDOWN_BARS}`,
    '',
  ].join('\n');
  fs.appendFileSync(envPath, patch);
  return { envPath, backupPath };
};

const startTinyLiveRuntime = async () => {
  const runId = nowTag();
  const port = process.env.TINY_LIVE_PORT || '8630';
  const dbPath = `./data/trader-tiny-live-${runId}.db`;
  const tinyLogPath = path.join(ROOT, 'debug', `tiny-live-runtime-${runId}.log`);
  const metaPath = path.join(ROOT, 'debug', `tiny-live-meta-${runId}.json`);

  const outFd = fs.openSync(tinyLogPath, 'a');
  const errFd = fs.openSync(tinyLogPath, 'a');
  const child = spawn('npm run dev', [], {
    cwd: ROOT,
    shell: true,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: {
      ...process.env,
      PORT: port,
      DB_PATH: dbPath,
      MARKET_MODE: 'binance',
      PAPER_ONLY: 'false',
      ROLLOUT_MODE: 'tiny_live',
      ENABLE_LIVE_ORDERS: 'true',
      TINY_LIVE_MAX_NOTIONAL_USD: TINY_LIVE_NOTIONAL,
      COOLDOWN_LOSS_STREAK,
      COOLDOWN_LOSS_MINUTES,
      RL_CONFIDENCE_GATE_ENABLED,
      RL_CONFIDENCE_Q_GAP,
      RL_MIN_HOLD_BARS,
      RL_FLIP_COOLDOWN_BARS,
    },
  });
  child.unref();
  await sleep(200);
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const meta = {
    runId,
    port: Number(port),
    pid: child.pid,
    dbPath,
    logPath: tinyLogPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { ...meta, metaPath };
};

const main = async () => {
  log('start', 'pipeline started', {
    baselineStatusPath: BASELINE_STATUS_PATH,
    paperDurationHours: PAPER_DURATION_HOURS,
  });

  log('smoke', 'running smoke index1 until pass');
  const smokeExec = await runNode('debug/run_smoke_index1_until_target.mjs', [], {
    PIPELINE_ID,
    MAX_ATTEMPTS: process.env.SMOKE_MAX_ATTEMPTS || '3',
    TARGET_TRADES: process.env.SMOKE_TARGET_TRADES || '100',
    MAX_WAIT_MS: process.env.SMOKE_MAX_WAIT_MS || '2400000',
  });
  log('smoke', 'smoke finished', { code: smokeExec.code });
  if (smokeExec.stdout) log('smoke', 'stdout', { text: smokeExec.stdout.slice(-4000) });
  if (smokeExec.stderr) log('smoke', 'stderr', { text: smokeExec.stderr.slice(-4000) });

  const smokeFinalPath = path.join(ROOT, 'debug', `smoke-index1-final-${PIPELINE_ID}.json`);
  const smokeFinal = fs.existsSync(smokeFinalPath)
    ? JSON.parse(fs.readFileSync(smokeFinalPath, 'utf8'))
    : null;
  if (!smokeFinal || smokeFinal.status !== 'passed') {
    const final = {
      status: 'stopped',
      reason: 'smoke_failed',
      pipelineId: PIPELINE_ID,
      smokeFinalPath,
      smokeFinal,
      logPath,
    };
    fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
    log('stop', 'pipeline stopped: smoke failed');
    process.exit(2);
  }

  log('paper', 'starting binance paper runtime with index1 params');
  const startPaper = await runNode('debug/start_realtime_index1_binance.mjs');
  if (startPaper.code !== 0) {
    const final = {
      status: 'stopped',
      reason: 'paper_start_failed',
      pipelineId: PIPELINE_ID,
      output: startPaper,
      logPath,
    };
    fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
    log('stop', 'pipeline stopped: paper start failed');
    process.exit(3);
  }
  const paperMeta = parseLastJsonLine(startPaper.stdout);
  if (!paperMeta?.status || paperMeta.status !== 'started') {
    const final = {
      status: 'stopped',
      reason: 'paper_meta_parse_failed',
      pipelineId: PIPELINE_ID,
      output: startPaper.stdout,
      logPath,
    };
    fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
    log('stop', 'pipeline stopped: paper meta parse failed');
    process.exit(4);
  }
  log('paper', 'paper runtime started', { port: paperMeta.port, pid: paperMeta.pid, statusPath: paperMeta.statusPath });

  log('paper', 'starting status poller');
  const pollResult = await runNode('debug/poll_runtime_status_1h.mjs', [], {
    RUN_ID: paperMeta.runId,
    STATUS_PATH: paperMeta.statusPath,
    RUNTIME_PORT: String(paperMeta.port),
    DURATION_MS: String(PAPER_DURATION_MS),
    POLL_MS: process.env.PAPER_POLL_MS || String(30_000),
  });
  log('paper', 'status poller finished', { code: pollResult.code });

  try {
    process.kill(Number(paperMeta.pid), 'SIGTERM');
    log('paper', 'paper runtime stopped', { pid: paperMeta.pid });
  } catch (error) {
    log('paper', 'paper runtime stop failed', { pid: paperMeta.pid, error: String(error) });
  }

  const comparisonOutPath = path.join(ROOT, 'debug', `index1-vs-baseline-${PIPELINE_ID}.json`);
  const compareExec = await runNode('debug/compare_status_runs.mjs', [BASELINE_STATUS_PATH, paperMeta.statusPath, comparisonOutPath]);
  log('compare', 'comparison complete', { code: compareExec.code, outPath: comparisonOutPath });
  if (compareExec.stdout) log('compare', 'stdout', { text: compareExec.stdout.slice(-1000) });

  const comparison = fs.existsSync(comparisonOutPath)
    ? JSON.parse(fs.readFileSync(comparisonOutPath, 'utf8'))
    : null;

  let tinyLive = null;
  if (comparison?.promoteTinyLive) {
    log('tiny_live', 'criteria passed, enabling tiny_live');
    const envEdit = updateEnvForTinyLive();
    const tiny = await startTinyLiveRuntime();
    tinyLive = { envEdit, tiny };
    log('tiny_live', 'tiny_live started', { port: tiny.port, pid: tiny.pid, metaPath: tiny.metaPath });
  } else {
    log('tiny_live', 'criteria not met, tiny_live not started');
  }

  const final = {
    status: 'completed',
    pipelineId: PIPELINE_ID,
    smokeFinalPath,
    paperMeta,
    comparisonOutPath,
    promoteTinyLive: Boolean(comparison?.promoteTinyLive),
    tinyLive,
    logPath,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
  log('done', 'pipeline completed', { finalPath, promoteTinyLive: final.promoteTinyLive });
};

main().catch(error => {
  const final = {
    status: 'error',
    pipelineId: PIPELINE_ID,
    error: String(error),
    logPath,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(finalPath, JSON.stringify(final, null, 2));
  log('error', 'pipeline crashed', { error: String(error), finalPath });
  process.exit(1);
});
