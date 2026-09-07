import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Query only the process group created by this task. Never infer ownership from
// a log URL or scan/adopt unrelated processes. Unsupported platforms fail closed.
export async function readTaskListeners(processGroupId) {
  if (process.platform === 'win32' || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return [];
  let stdout;
  try {
    ({ stdout } = await execFileAsync('lsof', [
      '-nP', '-a', '-g', String(processGroupId), '-iTCP', '-sTCP:LISTEN', '-Fpn',
    ], { timeout: 1500, maxBuffer: 64 * 1024 }));
  } catch { return []; }
  const listeners = [];
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || !pid) continue;
    const match = /^n(.+):(\d+)$/.exec(line);
    if (!match) continue;
    const port = Number(match[2]);
    if (port < 1 || port > 65535) continue;
    const host = match[1];
    if (listeners.some((entry) => entry.host === host && entry.port === port)) continue;
    listeners.push({ host, port, pid, transport: 'tcp', observedAt: new Date().toISOString() });
  }
  return listeners;
}
