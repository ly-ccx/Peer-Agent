import { createHash } from 'node:crypto';
import { fstatSync, lstatSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

const gatePath = '/run/peer-agent/interactive-maintenance.lock';
const configPath = '/etc/peer-agent/interactive-maintenance.json';
const bootPath = '/proc/sys/kernel/random/boot_id';
const unavailable = () => Object.assign(Error('interactive_retention_unavailable'), { code: 'interactive_retention_unavailable' });

function descriptor(arg: string | undefined): number {
  if (!arg || !/^[1-9][0-9]{0,5}$/.test(arg) || Number(arg) < 3) throw unavailable();
  return Number(arg);
}

function protectedFile(fd: number, path: string) {
  const stat = fstatSync(fd, { bigint: true });
  if (readlinkSync(`/proc/self/fd/${fd}`) !== path || !stat.isFile() || stat.uid !== 0n
    || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) throw unavailable();
  return stat;
}

/** A root-issued descriptor and its kernel lock must survive every source guard and commit. */
export function openInteractiveMaintenanceGate(args: string[]) {
  if (process.platform !== 'linux' || args.length !== 2) throw unavailable();
  const gate = descriptor(args[0]), enrollment = descriptor(args[1]);
  const config = protectedFile(enrollment, configPath);
  if (config.size <= 0n || config.size > 4096n) throw unavailable();
  const bytes = Buffer.alloc(Number(config.size));
  if (readSync(enrollment, bytes, 0, bytes.length, 0) !== bytes.length) throw unavailable();
  const { dataHome, dataDevice, dataInode, uid, gid, normalBootId } = JSON.parse(bytes.toString('utf8'));
  if (typeof dataHome !== 'string' || realpathSync(dataHome) !== dataHome || !uid || !gid
    || process.getuid?.() !== uid || process.geteuid?.() !== uid || process.getegid?.() !== gid
    || !/^NoNewPrivs:\s+1$/m.test(readFileSync('/proc/self/status', 'utf8'))) throw unavailable();
  for (let parent = dirname(dataHome); ; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw unavailable();
    if (parent === '/') break;
  }
  const boot = readFileSync(bootPath, 'utf8').trim();
  if (boot === normalBootId || !readFileSync('/proc/cmdline', 'utf8').trim().split(/\s+/).includes('systemd.unit=rescue.target'))
    throw unavailable();
  const gateFile = protectedFile(gate, gatePath);
  const revision = `sha256:${createHash('sha256').update(boot).update(bytes).digest('hex')}`;

  function assertCurrent() {
    try {
      const file = protectedFile(gate, gatePath), current = protectedFile(enrollment, configPath);
      if (file.dev !== gateFile.dev || file.ino !== gateFile.ino || current.dev !== config.dev || current.ino !== config.ino
        || current.ctimeNs !== config.ctimeNs || readFileSync(bootPath, 'utf8').trim() !== boot) return false;
      const root = lstatSync(dataHome, { bigint: true });
      if (!root.isDirectory() || root.uid !== BigInt(uid) || (root.mode & 0o7777n) !== 0o700n
        || root.dev.toString() !== dataDevice || root.ino.toString() !== dataInode) return false;
      return readFileSync(`/proc/self/fdinfo/${gate}`, 'utf8').split('\n').some(line => {
        const lock = line.trim().split(/\s+/);
        return lock[0] === 'lock:' && lock[2] === 'FLOCK' && lock[3] === 'ADVISORY'
          && lock[4] === 'WRITE' && lock[5] === String(process.pid)
          && lock[6]?.split(':')[2] === file.ino.toString() && lock[7] === '0' && lock[8] === 'EOF';
      });
    } catch { return false; }
  }
  if (!assertCurrent()) throw unavailable();
  return {
    dataHome: dataHome as string,
    acquireCompatibility() {
      if (!assertCurrent()) throw unavailable();
      let released = false;
      return { revision, assertCurrent: () => !released && assertCurrent(), release() { released = true; } };
    },
  };
}
