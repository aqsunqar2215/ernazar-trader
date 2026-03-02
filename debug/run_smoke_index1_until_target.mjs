import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const nowTag = () => new Date().toISOString().replace(/[:.]/g, '-');

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const TARGET_TRADES = Number(process.env.TARGET_TRADES || 100);
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 2_400_000);
const BASE_PORT = Number(process.env.BASE_PORT || 8618);
const PIPELINE_ID = process.env.PIPELINE_ID || nowTag();

const index1 = {
  qGap: '0.008',
  minHoldBars: '12',
  flipCooldownBars: '8',
  confidenceGateEnabled: 'false',
};

fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'debug', 'db'), { recursive: true });

const runAttempt = attempt =>
  new Promise(resolve => {
    const runId = `${PIPELINE_ID}-a${attempt}-${nowTag()}`;
    const port = BASE_PORT + attempt - 1;
    const profileId = `smoke-index1-${runId}`;
    const reportPath = path.join('debug', `shadow-report-smoke-index1-${runId}.json`);
    const metadataPath = path.join('debug', `runtime-profile-smoke-index1-${runId}.json`);
    const dbPath = path.join('.', 'debug', 'db', `trader-smoke-index1-${runId}.db`);
    const logPath = path.join(ROOT, 'debug', `smoke-index1-${runId}.log`);

    const out = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(process.execPath, ['debug/run-shadow-isolated.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROFILE_ID: profileId,
        PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}`,
        DB_PATH: dbPath,
        REPORT_PATH: reportPath,
        METADATA_PATH: metadataPath,
        MARKET_MODE: 'mock',
        ROLLOUT_MODE: 'paper',
        PAPER_ONLY: 'true',
        MOCK_CLOCK_OFFSET_MINUTES: '7200',
        TARGET_TRADES: String(TARGET_TRADES),
        POLL_MS: process.env.POLL_MS || '5000',
        MAX_WAIT_MS: String(MAX_WAIT_MS),
        USE_EXISTING_RUNTIME: '0',
        RL_CONFIDENCE_GATE_ENABLED: index1.confidenceGateEnabled,
        RL_CONFIDENCE_Q_GAP: index1.qGap,
        RL_MIN_HOLD_BARS: index1.minHoldBars,
        RL_FLIP_COOLDOWN_BARS: index1.flipCooldownBars,
        RL_SHADOW_GATE_ENABLED: 'false',
        ROLLOUT_PAPER_SANITY_MIN_NET_PNL_USD: '-5',
        ROLLOUT_PAPER_SANITY_MAX_DD_PCT: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdoutBuf += text;
      out.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrBuf += text;
      out.write(text);
    });

    child.on('exit', code => {
      out.end();
      let report = null;
      const absReportPath = path.join(ROOT, reportPath);
      if (fs.existsSync(absReportPath)) {
        try {
          report = JSON.parse(fs.readFileSync(absReportPath, 'utf8'));
        } catch {
          report = null;
        }
      }
      resolve({
        attempt,
        code,
        runId,
        port,
        profileId,
        reportPath: absReportPath,
        metadataPath: path.join(ROOT, metadataPath),
        logPath,
        report,
        tail: `${stdoutBuf}\n${stderrBuf}`.split(/\r?\n/).filter(Boolean).slice(-30),
      });
    });
  });

const main = async () => {
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await runAttempt(attempt);
    attempts.push(result);
    const reached = Boolean(result.report?.reachedTarget);
    const gatePassed = Boolean(result.report?.gate?.passed);
    const paperSanityPassed = Boolean(result.report?.paperSanity?.passed);
    if (reached && gatePassed && paperSanityPassed) {
      const finalPath = path.join(ROOT, 'debug', `smoke-index1-final-${PIPELINE_ID}.json`);
      fs.writeFileSync(
        finalPath,
        JSON.stringify(
          {
            status: 'passed',
            pipelineId: PIPELINE_ID,
            criteria: { reachedTarget: true, gatePassed: true, paperSanityPassed: true },
            winner: result,
            attempts,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ status: 'passed', pipelineId: PIPELINE_ID, finalPath, winnerRunId: result.runId }));
      return;
    }
  }

  const failedPath = path.join(ROOT, 'debug', `smoke-index1-final-${PIPELINE_ID}.json`);
  fs.writeFileSync(
    failedPath,
    JSON.stringify(
      {
        status: 'failed',
        pipelineId: PIPELINE_ID,
        criteria: { reachedTarget: true, gatePassed: true, paperSanityPassed: true },
        attempts,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: 'failed', pipelineId: PIPELINE_ID, finalPath: failedPath }));
  process.exit(2);
};

main().catch(error => {
  console.error(JSON.stringify({ status: 'error', pipelineId: PIPELINE_ID, error: String(error) }));
  process.exit(1);
});
