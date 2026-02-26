import { AppRuntime } from '../dist/app/runtime.js';

const runtime = new AppRuntime();

const main = async () => {
  await runtime.start();
  await new Promise(resolve => setTimeout(resolve, 600));

  const health = await fetch('http://127.0.0.1:8080/health').then(r => r.json());
  const candles = await fetch('http://127.0.0.1:8080/candles?symbol=BTCUSDT&tf=1m&limit=25').then(r => r.json());

  console.log(
    JSON.stringify({
      health,
      candlesCount: candles.count,
      firstCandle: candles.candles?.[0]?.openTime ?? null,
      lastCandle: candles.candles?.[candles.candles.length - 1]?.openTime ?? null,
    }),
  );

  await runtime.stop();
};

main().catch(async error => {
  console.error(String(error));
  await runtime.stop();
  process.exit(1);
});
