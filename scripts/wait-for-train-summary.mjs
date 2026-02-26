import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node scripts/wait-for-train-summary.mjs <logPath> [intervalMs] [maxWaitMs]');
  process.exit(2);
}

const intervalMs = Number(process.argv[3] ?? '30000');
const maxWaitMs = Number(process.argv[4] ?? String(40 * 60 * 1000));
const start = Date.now();

const hasSummary = content =>
  content.includes('"message":"target reached after full run"')
  || content.includes('"message":"target not reached"')
  || content.includes('"message":"train-until-target failed"');

while (true) {
  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch (error) {
    if (Date.now() - start > maxWaitMs) {
      console.error(JSON.stringify({ level: 'error', message: 'log file not found', logPath, error: String(error) }));
      process.exit(1);
    }
    await wait(intervalMs);
    continue;
  }

  if (hasSummary(content)) {
    break;
  }

  if (Date.now() - start > maxWaitMs) {
    console.error(JSON.stringify({ level: 'error', message: 'timeout waiting for summary', logPath, maxWaitMs }));
    process.exit(1);
  }

  await wait(intervalMs);
}

const result = spawnSync(process.execPath, ['scripts/summarize-train-log.mjs', logPath], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(result.status ?? 0);
