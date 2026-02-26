import fs from 'node:fs';

const file = process.argv[2] ?? 'train-target.log';
const last = Number(process.argv[3] ?? '120');

if (!fs.existsSync(file)) {
  console.error(`log file not found: ${file}`);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const tail = lines.slice(-last);

const interesting = tail.filter(line => {
  if (line.includes('"level":"critical"')) return true;
  if (line.includes('train-until-target failed')) return true;
  if (line.includes('target not reached')) return true;
  if (line.includes('train iteration')) return true;
  if (line.includes('rl retrain completed')) return true;
  if (line.includes('supervised retrain completed')) return true;
  if (line.includes('backtest run completed')) return true;
  if (line.includes('backtest gate failed')) return true;
  return false;
});

const output = (interesting.length > 0 ? interesting : tail).join('\n');
process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
