import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const HOURS = 60 * 60 * 1000;
const ROOT = process.cwd();
const nowTag = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

const defaultStatePath = `debug/live-ab-12h-state-${nowTag()}.json`;
const statePath = process.env.AB_STATE_PATH || defaultStatePath;

const baseRuntimeEnv = {
  MARKET_MODE: 'binance',
  ROLLOUT_MODE: 'paper',
  PAPER_ONLY: 'true',
  MAX_RISK_PER_TRADE_PCT: process.env.MAX_RISK_PER_TRADE_PCT || '0.5',
  MAX_ORDERS_PER_MINUTE: process.env.MAX_ORDERS_PER_MINUTE || '3',
  MAX_TURNOVER_PER_HOUR: process.env.MAX_TURNOVER_PER_HOUR || '24',
  RL_CONFIDENCE_GATE_ENABLED: process.env.RL_CONFIDENCE_GATE_ENABLED || 'true',
};

const presets = [
  {
    name: 'safe',
    runtimePort: process.env.AB_SAFE_PORT || '8641',
    durationMs: Number(process.env.AB_SAFE_DURATION_MS || 6 * HOURS),
    runtimeEnv: {
      RL_CONFIDENCE_Q_GAP: process.env.AB_SAFE_Q_GAP || '0.004',
      RL_MIN_HOLD_BARS: process.env.AB_SAFE_MIN_HOLD_BARS || '12',
      RL_FLIP_COOLDOWN_BARS: process.env.AB_SAFE_FLIP_COOLDOWN_BARS || '8',
      COOLDOWN_LOSS_STREAK: process.env.AB_SAFE_COOLDOWN_LOSS_STREAK || '5',
      COOLDOWN_LOSS_MINUTES: process.env.AB_SAFE_COOLDOWN_LOSS_MINUTES || '5',
    },
  },
  {
    name: 'aggressive',
    runtimePort: process.env.AB_AGGRESSIVE_PORT || '8642',
    durationMs: Number(process.env.AB_AGGRESSIVE_DURATION_MS || 6 * HOURS),
    runtimeEnv: {
      RL_CONFIDENCE_Q_GAP: process.env.AB_AGGRESSIVE_Q_GAP || '0.006',
      RL_MIN_HOLD_BARS: process.env.AB_AGGRESSIVE_MIN_HOLD_BARS || '8',
      RL_FLIP_COOLDOWN_BARS: process.env.AB_AGGRESSIVE_FLIP_COOLDOWN_BARS || '6',
      COOLDOWN_LOSS_STREAK: process.env.AB_AGGRESSIVE_COOLDOWN_LOSS_STREAK || '6',
      COOLDOWN_LOSS_MINUTES: process.env.AB_AGGRESSIVE_COOLDOWN_LOSS_MINUTES || '3',
    },
  },
];

const state = {
  startedAt: new Date().toISOString(),
  statePath,
  presets: presets.map(item => ({
    name: item.name,
    runtimePort: item.runtimePort,
    durationMs: item.durationMs,
    runtimeEnv: item.runtimeEnv,
  })),
  sessions: [],
  finishedAt: null,
  error: null,
};

const saveState = async () => {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
};

const runAndCapture = (command, args, options = {}) => new Promise(resolve => {
  const child = spawn(command, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  child.on('error', error => resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${String(error)}` }));
});

const parseStartedMeta = stdout => {
  const line = stdout
    .split(/\r?\n/g)
    .map(item => item.trim())
    .find(item => item.startsWith('{') && item.includes('"status":"started"'));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const killPid = async pid => {
  if (!pid || !Number.isFinite(Number(pid))) {
    return { code: null, signal: null, stdout: '', stderr: 'invalid pid' };
  }
  return await runAndCapture('taskkill', ['/PID', String(pid), '/T', '/F'], {
    cwd: ROOT,
    env: process.env,
    shell: true,
  });
};

const runSession = async preset => {
  const session = {
    name: preset.name,
    startedAt: new Date().toISOString(),
    durationMs: preset.durationMs,
    runtimePort: Number(preset.runtimePort),
    start: null,
    poll: null,
    stop: null,
    finishedAt: null,
    error: null,
  };
  state.sessions.push(session);
  await saveState();

  const startResult = await runAndCapture(
    process.execPath,
    ['debug/start_realtime_index1_binance.mjs'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...baseRuntimeEnv,
        ...preset.runtimeEnv,
        RUNTIME_PORT: String(preset.runtimePort),
      },
      shell: false,
    },
  );

  const startedMeta = parseStartedMeta(startResult.stdout);
  session.start = {
    ...startResult,
    meta: startedMeta,
  };
  await saveState();

  if (!startedMeta || startResult.code !== 0) {
    session.error = 'failed_to_start_runtime';
    session.finishedAt = new Date().toISOString();
    await saveState();
    return;
  }

  const pollResult = await runAndCapture(
    process.execPath,
    ['debug/poll_runtime_status_1h.mjs'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        RUN_ID: startedMeta.runId,
        STATUS_PATH: startedMeta.statusPath,
        RUNTIME_PORT: String(startedMeta.port),
        DURATION_MS: String(preset.durationMs),
        POLL_MS: process.env.AB_POLL_MS || '30000',
      },
      shell: false,
    },
  );

  session.poll = pollResult;
  await saveState();

  session.stop = await killPid(startedMeta.pid);
  session.finishedAt = new Date().toISOString();
  await saveState();
};

const main = async () => {
  await saveState();
  for (const preset of presets) {
    await runSession(preset);
  }
  state.finishedAt = new Date().toISOString();
  await saveState();
};

main().catch(async error => {
  state.error = String(error);
  state.finishedAt = new Date().toISOString();
  await saveState();
  process.exit(1);
});

