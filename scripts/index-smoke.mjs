import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', chunk => process.stdout.write(chunk));
child.stderr.on('data', chunk => process.stderr.write(chunk));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const main = async () => {
  await wait(700);
  const health = await fetch('http://127.0.0.1:8080/health').then(r => r.json());
  console.log(JSON.stringify({ indexEntrypoint: 'ok', health }));
};

main()
  .catch(error => {
    console.error(String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill('SIGTERM');
    await wait(300);
  });
