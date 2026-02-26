import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { resolve } from 'node:path';

const logPathArg = process.argv[2] ?? 'train-until-target.log';
const logPath = resolve(process.cwd(), logPathArg);
const out = openSync(logPath, 'a');

const child = spawn(process.execPath, ['scripts/train-until-target.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ['ignore', out, out],
});

child.unref();

console.log(
  JSON.stringify({
    level: 'info',
    message: 'background train started',
    pid: child.pid,
    logPath,
  }),
);
