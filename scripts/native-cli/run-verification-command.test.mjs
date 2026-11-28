import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

test('a failed verification command preserves exit 101 and stops its pipe-holding Node child', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-verify-command-'));
  const pidFile = join(root, 'child-pid');
  const logPath = join(root, 'command.log');
  const execute = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    writeFileSync(2, 'fixture failure\\n');
    child.unref();
    process.exit(101);
  `;
  const wrapper = `
    import { runVerificationCommand } from ${JSON.stringify(new URL('./run-verification-command.mjs', import.meta.url).href)};
    process.exit(runVerificationCommand(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(execute)}],
      { cwd: ${JSON.stringify(root)}, env: process.env, logPath: ${JSON.stringify(logPath)} }));
  `;
  const childState = pid => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 101);
    assert.match(result.stdout, /fixture failure/);
    assert.match(result.stderr, /Verification command failed \(exit 101\)/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = childState(pid);
      if (!state || state.startsWith('Z')) return;
      await setTimeout(20);
    }
    assert.fail(`verification left Node child ${pid} running`);
  } finally {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid > 0 && /^[^Z]/.test(childState(pid))) process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
