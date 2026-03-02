import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const now = new Date();
const runId = now.toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = process.env.SMOKE_PORT || '8618';
const profileId = `smoke-index1-port${port}-${runId}`;
const dbPath = `./debug/db/trader-${profileId}.db`;
const reportPath = `debug/shadow-report-smoke-index1-port${port}-${runId}.json`;
const profileMetaPath = `debug/runtime-profile-smoke-index1-port${port}-${runId}.json`;
const smokeLogPath = path.join(ROOT, 'debug', `smoke-index1-port${port}-${runId}.log`);
const starterMetaPath = path.join(ROOT, 'debug', `smoke-index1-starter-meta-${runId}.json`);

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'debug', 'db'), { recursive: true });

const outFd = fs.openSync(smokeLogPath, 'a');
const errFd = fs.openSync(smokeLogPath, 'a');

let spawnError = null;
const child = spawn(process.execPath, ['debug/run-shadow-isolated.mjs'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', outFd, errFd],
  env: {
    ...process.env,
    PROFILE_ID: profileId,
    PORT: port,
    BASE_URL: `http://127.0.0.1:${port}`,
    DB_PATH: dbPath,
    REPORT_PATH: reportPath,
    METADATA_PATH: profileMetaPath,
    MARKET_MODE: 'mock',
    ROLLOUT_MODE: 'paper',
    PAPER_ONLY: 'true',
    MOCK_CLOCK_OFFSET_MINUTES: '7200',
    TARGET_TRADES: process.env.TARGET_TRADES || '100',
    POLL_MS: process.env.POLL_MS || '5000',
    MAX_WAIT_MS: process.env.MAX_WAIT_MS || '1800000',
    USE_EXISTING_RUNTIME: '0',
    RL_CONFIDENCE_GATE_ENABLED: 'false',
    RL_CONFIDENCE_Q_GAP: '0.008',
    RL_MIN_HOLD_BARS: '12',
    RL_FLIP_COOLDOWN_BARS: '8',
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
  index: 1,
  profileId,
  port: Number(port),
  pid: child.pid,
  logPath: smokeLogPath,
  reportPath: path.join(ROOT, reportPath),
  profileMetaPath: path.join(ROOT, profileMetaPath),
  indexBinding: {
    qGap: 0.008,
    minHoldBars: 12,
    flipCooldownBars: 8,
    source: 'debug/shadow-report-screening-top3.json index=1',
  },
  startedAt: new Date().toISOString(),
};

fs.writeFileSync(starterMetaPath, JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ status: 'started', ...meta }));
