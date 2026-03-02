import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const defaults = {
  SELF_IMPROVE_BATCH_ITERS: '16',
  SELF_IMPROVE_MAX_CYCLES: '0',
  SELF_IMPROVE_CYCLE_SLEEP_MS: '4000',
  SELF_IMPROVE_MIN_TRADES_FOR_STABLE: '1',
  SELF_IMPROVE_MIN_SCORE_DELTA: '0',
  SELF_IMPROVE_RESET_BONUS_ITERS: '2',
  MAX_WAIT_MS: '150000',
  POLL_MS: '3000',
};

const normalize = value => String(value).trim();

const run = () => {
  const cwd = process.cwd();
  const debugDir = resolve('debug');
  const logPath = resolve(process.env.SELF_IMPROVE_DAEMON_LOG_PATH ?? 'debug/self-improve-continuous-live.log');
  const pidPath = resolve(process.env.SELF_IMPROVE_DAEMON_PID_PATH ?? 'debug/self-improve-continuous.pid');

  mkdirSync(debugDir, { recursive: true });

  const env = { ...process.env };
  for (const [key, value] of Object.entries(defaults)) {
    env[key] = env[key] === undefined ? value : env[key];
    env[key] = normalize(env[key]);
  }

  const out = openSync(logPath, 'a');
  const err = openSync(logPath, 'a');

  const child = spawn(process.execPath, ['debug/run-shadow-live-self-improve-continuous.mjs'], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', out, err],
  });

  child.unref();

  const payload = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    pidPath,
    env: {
      SELF_IMPROVE_BATCH_ITERS: env.SELF_IMPROVE_BATCH_ITERS,
      SELF_IMPROVE_MAX_CYCLES: env.SELF_IMPROVE_MAX_CYCLES,
      SELF_IMPROVE_CYCLE_SLEEP_MS: env.SELF_IMPROVE_CYCLE_SLEEP_MS,
      MAX_WAIT_MS: env.MAX_WAIT_MS,
      POLL_MS: env.POLL_MS,
    },
  };

  writeFileSync(pidPath, JSON.stringify(payload, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

run();
