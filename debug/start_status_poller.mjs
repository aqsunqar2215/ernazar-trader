import { spawn } from 'node:child_process';

const runId = process.env.RUN_ID;
const statusPath = process.env.STATUS_PATH;
const port = process.env.RUNTIME_PORT || '8081';
const durationMs = process.env.DURATION_MS || String(60 * 60 * 1000);
const pollMs = process.env.POLL_MS || String(30 * 1000);

if (!runId || !statusPath) {
  console.error(JSON.stringify({ status: 'error', message: 'RUN_ID and STATUS_PATH are required' }));
  process.exit(1);
}

const child = spawn(
  'node debug/poll_runtime_status_1h.mjs',
  [],
  {
    cwd: process.cwd(),
    shell: true,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      RUN_ID: runId,
      STATUS_PATH: statusPath,
      RUNTIME_PORT: port,
      DURATION_MS: durationMs,
      POLL_MS: pollMs,
    },
  },
);

let spawnError = null;
child.on('error', error => {
  spawnError = String(error);
});

child.unref();
await new Promise(resolve => setTimeout(resolve, 200));

if (spawnError) {
  console.error(JSON.stringify({ status: 'error', runId, error: spawnError }));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'started', runId, pid: child.pid, statusPath, port: Number(port) }));
