import fs from 'node:fs';
import { spawn } from 'node:child_process';

const nowTag = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const jobId = process.env.AB_JOB_ID || nowTag();
const logPath = process.env.AB_LOG_PATH || `debug/live-ab-12h-${jobId}.log`;
const statePath = process.env.AB_STATE_PATH || `debug/live-ab-12h-state-${jobId}.json`;

fs.mkdirSync('debug', { recursive: true });
const outFd = fs.openSync(logPath, 'a');
const errFd = fs.openSync(logPath, 'a');

const child = spawn(
  process.execPath,
  ['debug/run_live_ab_12h.mjs'],
  {
    cwd: process.cwd(),
    shell: false,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: {
      ...process.env,
      AB_STATE_PATH: statePath,
    },
  },
);

let spawnError = null;
child.on('error', error => {
  spawnError = String(error);
});

child.unref();
await new Promise(resolve => setTimeout(resolve, 200));
fs.closeSync(outFd);
fs.closeSync(errFd);

if (spawnError) {
  console.error(JSON.stringify({ status: 'error', jobId, error: spawnError }));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'started', jobId, pid: child.pid, logPath, statePath }));

