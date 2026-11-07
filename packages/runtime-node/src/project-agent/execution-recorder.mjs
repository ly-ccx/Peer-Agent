import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function text(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** Current boot identity. A missing boot id makes every death proof unavailable. */
export function localBootId() {
  const linux = text('/proc/sys/kernel/random/boot_id');
  if (linux) return linux;
  try {
    const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
    const match = out.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
    if (match) return `boottime:${match[1]}.${match[2]}`;
  } catch { /* non-mac hosts have no sysctl boottime */ }
  return null;
}

/** Process start token for one pid. Linux uses starttime ticks; macOS uses lstart. */
export function localPidStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const stat = text(`/proc/${pid}/stat`);
  if (stat) {
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (rest[19]) return `linux:${rest[19]}`;
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (out) return `macos:${out}`;
  } catch { /* the pid is already gone, or ps is unavailable */ }
  return null;
}

let selfIdentity;
export function localRecorderIdentity() {
  if (!selfIdentity) {
    const pid = process.pid;
    selfIdentity = { bootId: localBootId(), pid, pidStart: localPidStart(pid) };
  }
  // This process cannot observe its own later death. Other pids are looked up live.
  return { ...selfIdentity, lookup: target => target === selfIdentity.pid ? selfIdentity.pidStart : localPidStart(target) };
}

export function recorderComplete(recorder) {
  return Boolean(recorder && typeof recorder.bootId === 'string' && recorder.bootId
    && Number.isSafeInteger(recorder.pid) && recorder.pid > 0
    && typeof recorder.pidStart === 'string' && recorder.pidStart
    && typeof recorder.hostId === 'string' && recorder.hostId
    && typeof recorder.acquiredAt === 'string' && recorder.acquiredAt);
}

/**
 * Death proof for one recorded local process.
 * `dead` and `reused` are same-boot proofs. `different_boot` means that boot's process
 * is not this boot's process. `alive` matches pid and start. Anything incomplete is `unproven`.
 * A bare ESRCH, a bare pid, or digits inside hostEpoch are not accepted here.
 */
export function proveRecorder(recorder, identity) {
  if (!recorderComplete(recorder) || !identity?.bootId) return 'unproven';
  if (recorder.bootId !== identity.bootId) return 'different_boot';
  if (typeof identity.lookup !== 'function') return 'unproven';
  const actual = identity.lookup(recorder.pid);
  if (!actual) return 'dead';
  if (actual !== recorder.pidStart) return 'reused';
  return 'alive';
}

export function recorderAllowsSettlement(proof) {
  return proof === 'dead' || proof === 'reused' || proof === 'different_boot';
}
