import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const now = new Date();
const runId = now.toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = process.env.RERUN_PORT || '8081';
const dbPath = `./data/trader-rerun-${runId}.db`;

const logPath = path.join(ROOT, 'debug', `live-paper-runtime-rerun-${runId}.log`);
const statusPath = path.join(ROOT, 'debug', `live-paper-status-rerun-${runId}.jsonl`);
const metaPath = path.join(ROOT, 'debug', `live-paper-rerun-meta-${runId}.json`);

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });

const outFd = fs.openSync(logPath, 'a');
const errFd = fs.openSync(logPath, 'a');

const child = spawn('npm run dev', [], {
  cwd: ROOT,
  shell: true,
  detached: true,
  stdio: ['ignore', outFd, errFd],
  env: {
    ...process.env,
    PORT: port,
    DB_PATH: dbPath,
    COOLDOWN_LOSS_STREAK: '999',
  },
});

let spawnError = null;
child.on('error', error => {
  spawnError = String(error);
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
  logPath,
  statusPath,
  startedAt: new Date().toISOString(),
  overrides: {
    PORT: port,
    DB_PATH: dbPath,
    COOLDOWN_LOSS_STREAK: '999',
  },
};

if (spawnError) {
  console.error(JSON.stringify({ status: 'error', runId, error: spawnError }));
  process.exit(1);
}

fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ status: 'started', ...meta }));
