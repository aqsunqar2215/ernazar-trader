import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const run = () => {
  const pidPath = resolve(process.env.SELF_IMPROVE_DAEMON_PID_PATH ?? 'debug/self-improve-continuous.pid');
  let payload;

  try {
    payload = JSON.parse(readFileSync(pidPath, 'utf8'));
  } catch {
    process.stdout.write(`${JSON.stringify({ stopped: false, reason: 'pid_file_not_found', pidPath })}\n`);
    process.exit(1);
  }

  const pid = Number(payload?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stdout.write(`${JSON.stringify({ stopped: false, reason: 'invalid_pid', pidPath, pid: payload?.pid ?? null })}\n`);
    process.exit(1);
  }

  try {
    process.kill(pid);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      stopped: false,
      reason: 'kill_failed',
      pid,
      message: String(error),
    })}\n`);
    process.exit(1);
  }

  try {
    unlinkSync(pidPath);
  } catch {
    // no-op
  }

  process.stdout.write(`${JSON.stringify({ stopped: true, pid, pidPath, stoppedAt: new Date().toISOString() })}\n`);
};

run();
