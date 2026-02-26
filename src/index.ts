import { AppRuntime } from './app/runtime.js';

const runtime = new AppRuntime();

const shutdown = async (signal: string): Promise<void> => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', signal, message: 'shutdown requested' }));
  await runtime.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

runtime.start().catch(async error => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      message: 'runtime start failed',
      error: String(error),
    }),
  );
  await runtime.stop();
  process.exit(1);
});
