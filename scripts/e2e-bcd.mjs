import { spawn } from 'node:child_process';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', chunk => process.stdout.write(chunk));
child.stderr.on('data', chunk => process.stderr.write(chunk));

const get = async path => fetch(`http://127.0.0.1:8080${path}`).then(r => r.json());
const post = async path => fetch(`http://127.0.0.1:8080${path}`, { method: 'POST' }).then(r => r.json());

const main = async () => {
  await wait(1200);

  const health = await get('/health');
  const status = await get('/runtime/status');
  const backtestBefore = await get('/backtest/status');
  const backtestRun = await post('/backtest/run');
  const mlRetrain = await post('/ml/retrain');
  const registry = await get('/ml/registry');
  const rl = await get('/rl/status');
  const alerts = await get('/runtime/alerts?limit=5');
  const audit = await get('/runtime/audit?limit=5');

  console.log(
    JSON.stringify({
      healthOk: health.status === 'ok',
      stage: status.stage,
      backtestGateBefore: backtestBefore.passed,
      backtestGateAfter: backtestRun.passed,
      mlRetrain,
      registryChampion: registry.champion ? registry.champion.id : null,
      rlEnabled: rl.enabled,
      rlModelKind: rl.modelKind,
      alertsCount: alerts.alerts?.length ?? 0,
      auditCount: audit.events?.length ?? 0,
    }),
  );
};

main()
  .catch(error => {
    console.error(String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill('SIGTERM');
    await wait(500);
  });
