import fs from 'node:fs';

const logPath = process.argv[2];

if (!logPath) {
  console.log(JSON.stringify({ status: 'error', message: 'usage: node debug/check_smoke_progress.mjs <logPath>' }));
  process.exit(1);
}

if (!fs.existsSync(logPath)) {
  console.log(JSON.stringify({ status: 'missing', logPath }));
  process.exit(0);
}

const lines = fs
  .readFileSync(logPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);

let lastSnapshot = null;
let result = null;

for (const line of lines) {
  if (line.startsWith('{"ts"')) {
    try {
      lastSnapshot = JSON.parse(line);
    } catch {
      // ignore malformed line
    }
    continue;
  }
  if (line.startsWith('RESULT ')) {
    try {
      result = JSON.parse(line.slice(7));
    } catch {
      // ignore malformed line
    }
  }
}

const payload = {
  logPath,
  totalLines: lines.length,
  lastSnapshot,
  tailRawLines: lines.slice(-20),
  finished: Boolean(result),
  result: result
    ? {
        reachedTarget: result.reachedTarget,
        targetTrades: result.targetTrades,
        overallPassed: result.overallPassed,
        elapsedMs: result.elapsedMs,
      }
    : null,
};

console.log(JSON.stringify(payload, null, 2));
