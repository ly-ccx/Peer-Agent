// H0-only feasibility experiment. No product imports, user profile or keychain access.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, copyFileSync, chmodSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const supported = process.platform === 'darwin';
let root, binary;
before(() => {
  if (!supported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-h0-')));
  binary = join(root, 'probe');
  const compile = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-o', binary,
    fileURLToPath(new URL('./h0-host-probe.c', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
});
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function directory() {
  return realpathSync(mkdtempSync(join(root, 'case-')));
}
function child(args) {
  const process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const waiters = [];
  process.stdout.on('data', data => {
    out += data;
    for (const waiter of [...waiters]) if (out.includes(waiter.text)) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve();
    }
  });
  process.stderr.on('data', data => { err += data; });
  const exited = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Early exit ${code}/${signal}: ${out} ${err}`));
      resolve({ code, signal, out, err });
    });
  });
  return { process, exited,
    line(text) { return out.includes(text) ? Promise.resolve() : new Promise((resolve, reject) => waiters.push({ text, resolve, reject })); },
    async cleanup() {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      await exited;
    },
  };
}
const options = { skip: !supported && 'macOS getpeereid experiment only', timeout: 10000 };
for (const state of ['running', 'suspended', 'released', 'killed']) {
  for (const alias of [false, true]) {
    test(`H0-lock-${state}-alias-${alias}`, options, async t => {
      const dir = directory(); const profile = join(dir, 'profile'); mkdirSync(profile, { mode: 0o700 });
      const link = join(dir, 'alias'); symlinkSync(profile, link);
      assert.equal(realpathSync(link), realpathSync(profile));
      const owner = child(['lock', join(profile, 'owner.lock')]);
      t.after(() => owner.cleanup()); await owner.line('LOCKED');
      if (state === 'suspended') {
        owner.process.kill('SIGSTOP');
        // Observe kernel process state, not a fixed sleep pretending suspension occurred.
        const deadline = performance.now() + 2000;
        for (;;) {
          const ps = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(owner.process.pid)], { encoding: 'utf8' });
          assert.equal(ps.status, 0, ps.stderr);
          if (ps.stdout.includes('T')) break;
          assert.ok(performance.now() < deadline, 'process did not enter stopped state');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      if (state === 'released') { owner.process.stdin.end(); assert.equal((await owner.exited).code, 0); }
      if (state === 'killed') { owner.process.kill('SIGKILL'); assert.equal((await owner.exited).signal, 'SIGKILL'); }
      const contender = child(['lock', join(alias ? link : profile, 'owner.lock')]);
      t.after(() => contender.cleanup());
      contender.process.stdin.end();
      const result = await contender.exited;
      const available = ['released', 'killed'].includes(state);
      assert.equal(result.code, available ? 0 : 73, result.err);
      assert.equal(result.out.includes('LOCKED'), available);
      if (state === 'suspended') owner.process.kill('SIGCONT');
    });
  }
}
for (const allow of [true, false]) {
  test(`H0-peer-kernel-identity-policy-${allow}`, options, async t => {
    const dir = directory(); const socketPath = join(dir, 'peer.sock');
    const uid = process.getuid(); const expected = allow ? uid : uid + 1;
    const server = child(['peer', socketPath, String(expected)]);
    t.after(() => server.cleanup()); await server.line('LISTENING');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    const socket = createConnection(socketPath);
    t.after(() => socket.destroy());
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => { socket.write(JSON.stringify({ uid: uid + 1, role: 'admin' })); resolve(); });
    });
    const result = await server.exited;
    assert.equal(result.code, allow ? 0 : 77, result.err);
    assert.match(result.out, new RegExp(`PEER ${uid} [0-9]+ ${allow ? 'ALLOW' : 'DENY'}`));
    // Same OS user in BOTH tests. A mismatched policy is not an actual cross-UID test.
  });
}
test('H0-lock-rejects-symlink-leaf', options, async t => {
  const dir = directory(); const lock = join(dir, 'lock');
  const owner = child(['lock', lock]); t.after(() => owner.cleanup()); await owner.line('LOCKED');
  const alias = join(dir, 'leaf'); symlinkSync(lock, alias);
  const other = child(['lock', alias]); t.after(() => other.cleanup()); other.process.stdin.end();
  const result = await other.exited;
  assert.equal(result.code, 1); assert.equal(result.out.includes('LOCKED'), false);
});
test('H0-socket-stale-after-kill-blocks-rebind-until-owner-cleanup', options, async t => {
  const dir = directory(); const socketPath = join(dir, 'peer.sock');
  const owner = child(['listen', socketPath]);
  t.after(() => owner.cleanup());
  await owner.line('LISTENING');
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  owner.process.kill('SIGKILL');
  assert.equal((await owner.exited).signal, 'SIGKILL');
  // SIGKILL leaves a stale endpoint behind; a new process must not blind-bind over it.
  assert.equal(statSync(socketPath).isSocket(), true);
  const blocked = child(['listen', socketPath]);
  t.after(() => blocked.cleanup());
  blocked.process.stdin.end();
  assert.equal((await blocked.exited).code, 1, 'stale socket must reject plain rebind');
  // Cleanup is only safe for whoever holds the directory lock; the test performs it explicitly.
  rmSync(socketPath);
  const replacement = child(['listen', socketPath]);
  t.after(() => replacement.cleanup());
  await replacement.line('LISTENING');
  replacement.process.stdin.end();
  assert.equal((await replacement.exited).code, 0);
  assert.equal(existsSync(socketPath), false, 'clean release removes the endpoint');
});
test('H0-socket-clean-release-allows-rebind', options, async t => {
  const dir = directory(); const socketPath = join(dir, 'peer.sock');
  const first = child(['listen', socketPath]);
  t.after(() => first.cleanup());
  await first.line('LISTENING');
  first.process.stdin.end();
  assert.equal((await first.exited).code, 0);
  const second = child(['listen', socketPath]);
  t.after(() => second.cleanup());
  await second.line('LISTENING');
  second.process.stdin.end();
  assert.equal((await second.exited).code, 0);
});
test('H0-copied-node-empty-environment-sqlite', options, () => {
  const dir = directory(); const node = join(dir, 'node');
  copyFileSync(process.execPath, node); chmodSync(node, 0o700);
  const code = `import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync('probe.sqlite');
    db.exec('CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (42)');
    db.close(); const reopened = new DatabaseSync('probe.sqlite');
    if (reopened.prepare('SELECT value FROM sample').get().value !== 42) throw Error('persistence');
    reopened.close();
    console.log(JSON.stringify({node:process.version,electron:process.versions.electron??null,sqlite:true}));`;
  const run = spawnSync(node, ['--input-type=module', '-e', code], { cwd: dir, env: {}, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  assert.deepEqual(JSON.parse(run.stdout), { node: process.version, electron: null, sqlite: true });
  // No package dependencies, signing/notarization, foreign architectures or Keychain are tested.
});
