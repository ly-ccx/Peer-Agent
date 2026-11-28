import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';

export function runVerificationCommand(command, args, { cwd, env, logPath }) {
  // Descendants inherit a file, so they cannot keep the Actions output pipe
  // open after a failing command. The Unix group belongs to this launch.
  const detached = process.platform !== 'win32';
  const log = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, { cwd, env, detached, stdio: ['ignore', log, log] });
  } finally {
    closeSync(log);
  }
  if (detached && result.pid > 0) {
    try { process.kill(-result.pid, 'SIGKILL'); }
    catch (error) {
      if (error.code !== 'ESRCH') writeFileSync(2, `Could not stop verification command group: ${error.message}\n`);
    }
  }

  writeFileSync(1, readFileSync(logPath));
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.signal ?? `exit ${result.status}`;
    writeFileSync(2, `Verification command failed (${detail})\n${command} ${args.join(' ')}\n`);
  }
  return result.status ?? 1;
}
