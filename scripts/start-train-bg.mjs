import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const logFile = process.argv[2] ?? 'train-bg.log';
const maxIters = process.argv[3] ?? '10000';
const promotedOnly = process.argv[4] ?? '1';
const sleepMs = process.argv[5] ?? '30000';
const warmupMs = process.argv[6] ?? '20000';

const out = fs.openSync(logFile, 'a');
const env = {
  ...process.env,
  MAX_ITERS: String(maxIters),
  TARGET_PROMOTED_ONLY: String(promotedOnly),
  SLEEP_BETWEEN_ITERS_MS: String(sleepMs),
  WARMUP_MS: String(warmupMs),
  FORCE_NEW_RUNTIME: process.env.FORCE_NEW_RUNTIME ?? '1',
  USE_EXISTING_RUNTIME: process.env.USE_EXISTING_RUNTIME ?? '0',
  MARKET_MODE: process.env.MARKET_MODE ?? 'mock',
  PAPER_ONLY: process.env.PAPER_ONLY ?? 'true',
  ROLLOUT_MODE: process.env.ROLLOUT_MODE ?? 'paper',
};

const trainScript = path.join(process.cwd(), 'scripts', 'train-until-target.mjs');
const child = spawn(process.execPath, [trainScript], {
  cwd: process.cwd(),
  detached: true,
  stdio: ['ignore', out, out],
  env,
});

child.on('error', error => {
  fs.appendFileSync(logFile, `\n[start-train-bg] spawn error: ${String(error)}\n`);
  process.stderr.write(`spawn error: ${String(error)}\n`);
  process.exit(1);
});

child.unref();
process.stdout.write(`${child.pid}\n`);
