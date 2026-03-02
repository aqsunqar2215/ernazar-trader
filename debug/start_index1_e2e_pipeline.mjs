import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const now = new Date();
const runId = now.toISOString().replace(/[:.]/g, '-');
const pipelineId = `index1-e2e-${runId}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const launcherLogPath = path.join(ROOT, 'debug', `index1-e2e-launcher-${runId}.log`);
const metaPath = path.join(ROOT, 'debug', `index1-e2e-launcher-meta-${runId}.json`);

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });

const outFd = fs.openSync(launcherLogPath, 'a');
const errFd = fs.openSync(launcherLogPath, 'a');

let spawnError = null;
const child = spawn(process.execPath, ['debug/run_index1_e2e_pipeline.mjs'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', outFd, errFd],
  env: {
    ...process.env,
    PIPELINE_ID: pipelineId,
    PAPER_DURATION_HOURS: process.env.PAPER_DURATION_HOURS || '4',
    BASELINE_STATUS_PATH:
      process.env.BASELINE_STATUS_PATH || 'debug/live-paper-status-rerun-2026-03-01T19-50-43-790Z.jsonl',
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
  status: 'started',
  runId,
  pipelineId,
  pid: child.pid,
  startedAt: new Date().toISOString(),
  launcherLogPath,
  pipelineLogPath: path.join(ROOT, 'debug', `index1-e2e-${pipelineId}.log`),
  finalPath: path.join(ROOT, 'debug', `index1-e2e-final-${pipelineId}.json`),
};
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ ...meta, metaPath }));
