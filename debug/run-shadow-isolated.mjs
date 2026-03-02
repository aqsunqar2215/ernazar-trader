import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const nowTag = () => new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replaceAll('-', '');
const randomTag = () => Math.random().toString(36).slice(2, 8);

const profileId = process.env.PROFILE_ID ?? `${nowTag()}-${randomTag()}`;
const port = Number(process.env.PORT ?? 8200 + Math.floor(Math.random() * 500));
const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
const dbPath = process.env.DB_PATH ?? `debug/db/trader-${profileId}.db`;
const reportPath = process.env.REPORT_PATH ?? `debug/shadow-report-${profileId}.json`;
const metadataPath = process.env.METADATA_PATH ?? `debug/runtime-profile-${profileId}.json`;
const cleanupDb = (process.env.CLEANUP_DB ?? '0') === '1';

const run = async () => {
  await mkdir(resolve('debug', 'db'), { recursive: true });
  await rm(resolve(dbPath), { force: true });
  await rm(resolve(`${dbPath}-shm`), { force: true });
  await rm(resolve(`${dbPath}-wal`), { force: true });

  const startedAt = new Date().toISOString();
  const childEnv = {
    ...process.env,
    PROFILE_ID: profileId,
    PORT: String(port),
    BASE_URL: baseUrl,
    DB_PATH: dbPath,
    REPORT_PATH: reportPath,
    USE_EXISTING_RUNTIME: process.env.USE_EXISTING_RUNTIME ?? '0',
  };

  const metadata = {
    profileId,
    startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    baseUrl,
    port,
    dbPath,
    reportPath,
    cleanupDb,
    env: {
      MARKET_MODE: childEnv.MARKET_MODE ?? null,
      ROLLOUT_MODE: childEnv.ROLLOUT_MODE ?? null,
      PAPER_ONLY: childEnv.PAPER_ONLY ?? null,
      MOCK_CLOCK_OFFSET_MINUTES: childEnv.MOCK_CLOCK_OFFSET_MINUTES ?? null,
      RL_CONFIDENCE_GATE_ENABLED: childEnv.RL_CONFIDENCE_GATE_ENABLED ?? null,
      RL_CONFIDENCE_Q_GAP: childEnv.RL_CONFIDENCE_Q_GAP ?? null,
      RL_MIN_HOLD_BARS: childEnv.RL_MIN_HOLD_BARS ?? null,
      RL_FLIP_COOLDOWN_BARS: childEnv.RL_FLIP_COOLDOWN_BARS ?? null,
      TARGET_TRADES: childEnv.TARGET_TRADES ?? null,
      POLL_MS: childEnv.POLL_MS ?? null,
      MAX_WAIT_MS: childEnv.MAX_WAIT_MS ?? null,
      RL_SHADOW_GATE_REQUIRED_TIER: childEnv.RL_SHADOW_GATE_REQUIRED_TIER ?? null,
    },
  };

  process.stdout.write(`ISOLATED_PROFILE ${JSON.stringify({ profileId, baseUrl, dbPath, reportPath })}\n`);

  const result = await new Promise(resolveExit => {
    const child = spawn(process.execPath, ['debug/run-shadow-until-trades.mjs'], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });

  metadata.endedAt = new Date().toISOString();
  metadata.exitCode = result.code;
  metadata.signal = result.signal;
  await writeFile(resolve(metadataPath), JSON.stringify(metadata, null, 2), 'utf8');

  if (cleanupDb) {
    await rm(resolve(dbPath), { force: true });
    await rm(resolve(`${dbPath}-shm`), { force: true });
    await rm(resolve(`${dbPath}-wal`), { force: true });
  }

  process.stdout.write(`ISOLATED_PROFILE_DONE ${JSON.stringify({ profileId, metadataPath, exitCode: result.code, signal: result.signal })}\n`);
  if (typeof result.code === 'number') {
    process.exitCode = result.code;
  } else {
    process.exitCode = 1;
  }
};

run().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
