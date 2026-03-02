import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const now = new Date();
const runId = now.toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = process.env.RUNTIME_PORT || '8625';
const dbPath = `./data/trader-index1-paper-${runId}.db`;
const logPath = path.join(ROOT, 'debug', `live-paper-runtime-index1-${runId}.log`);
const statusPath = path.join(ROOT, 'debug', `live-paper-status-index1-${runId}.jsonl`);
const metaPath = path.join(ROOT, 'debug', `live-paper-index1-meta-${runId}.json`);

const overrides = {
  PORT: port,
  DB_PATH: dbPath,
  // Keep loss-streak cooldown active for paper quality.
  COOLDOWN_LOSS_STREAK: process.env.COOLDOWN_LOSS_STREAK || '3',
  // Use timed cooldown to avoid indefinite strategy lock.
  COOLDOWN_LOSS_MINUTES: process.env.COOLDOWN_LOSS_MINUTES || '15',
  MARKET_MODE: 'binance',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  // More conservative execution guards for real paper runtime.
  RL_CONFIDENCE_GATE_ENABLED: process.env.RL_CONFIDENCE_GATE_ENABLED || 'true',
  RL_CONFIDENCE_Q_GAP: process.env.RL_CONFIDENCE_Q_GAP || '0.0015',
  RL_MIN_HOLD_BARS: process.env.RL_MIN_HOLD_BARS || '30',
  RL_FLIP_COOLDOWN_BARS: process.env.RL_FLIP_COOLDOWN_BARS || '45',
  // Reduce over-trading footprint on paper.
  MAX_RISK_PER_TRADE_PCT: process.env.MAX_RISK_PER_TRADE_PCT || '0.5',
  MAX_ORDERS_PER_MINUTE: process.env.MAX_ORDERS_PER_MINUTE || '3',
  MAX_TURNOVER_PER_HOUR: process.env.MAX_TURNOVER_PER_HOUR || '24',
};

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });

const outFd = fs.openSync(logPath, 'a');
const errFd = fs.openSync(logPath, 'a');

let spawnError = null;
const child = spawn('npm run dev', [], {
  cwd: ROOT,
  shell: true,
  detached: true,
  stdio: ['ignore', outFd, errFd],
  env: {
    ...process.env,
    ...overrides,
  },
});

child.on('error', error => {
  spawnError = String(error);
});

child.unref();
await sleep(200);
fs.closeSync(outFd);
fs.closeSync(errFd);

if (spawnError) {
  console.error(JSON.stringify({ status: 'error', runId, error: spawnError }));
  process.exit(1);
}

const meta = {
  runId,
  port: Number(port),
  pid: child.pid,
  dbPath,
  logPath,
  statusPath,
  startedAt: new Date().toISOString(),
  profile: 'index1-paper-binance',
  overrides,
};

fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ status: 'started', ...meta }));
