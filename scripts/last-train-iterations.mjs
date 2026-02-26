import fs from 'node:fs';

const file = process.argv[2] ?? 'train-bg.log';
const count = Math.max(1, Number(process.argv[3] ?? '20'));

if (!fs.existsSync(file)) {
  console.error(`log file not found: ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const rows = [];

for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  if (obj?.message !== 'train iteration') continue;
  rows.push({
    iter: obj.iter ?? null,
    attempted: obj.attempted ?? null,
    promoted: obj.promoted ?? null,
    winRate: obj.winRate ?? null,
    netPnl: obj.netPnl ?? null,
    challengerId: obj.challengerId ?? null,
    reason: obj.reason ?? null,
  });
}

const out = rows.slice(-count);
process.stdout.write(`${JSON.stringify({ file, totalTrainIterations: rows.length, returned: out.length, rows: out }, null, 2)}\n`);
