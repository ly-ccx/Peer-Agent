import assert from 'node:assert/strict';
import { realpathSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeShellSessionManager } from './shell-session.ts';
import { executionHandlesLive, stopExecutionHandles } from './project-agent/execution-handles.mjs';

const posixOnly = process.platform === 'win32' ? { skip: 'POSIX persistent shell only' } : {};

test('an idle managed shell remains a native handle until the shared stop barrier closes it', posixOnly, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-native-handle-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(workspaceRoot,{recursive:true,force:true})));
  const manager=createManager(t,workspaceRoot), conversationId='managed-shell-stop';
  const result=await manager.runCommand({conversationId,toolCallId:'actual-call',command:'printf done',timeoutMs:5000});
  assert.equal(result.status,'completed');
  assert.equal(executionHandlesLive(conversationId),true,'command completion does not prove its persistent shell has exited');
  await stopExecutionHandles(conversationId);
  assert.equal(executionHandlesLive(conversationId),false);
});

test('persistent Shell stop waits for a resistant descendant after its leader exits', posixOnly, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-original-shell-group-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const manager = createNodeShellSessionManager({ workspaceRoot, shellPath: '/bin/sh', killGraceMs: 80 });
  const conversationId = 'original-group-stop';
  const groupAlive = (pid: number) => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  const result = await manager.runCommand({ conversationId, toolCallId: 'start-child', timeoutMs: 5000,
    command: `printf '%s\\n' "$$" > leader
/bin/sh -c 'trap "" INT TERM; : > ready; exec /bin/sleep 30' </dev/null >/dev/null 2>&1 &
while [ ! -f ready ]; do /bin/sleep 0.01; done`,
  });
  assert.equal(result.status, 'completed');
  const leader = Number(await readFile(path.join(workspaceRoot, 'leader'), 'utf8'));
  assert(Number.isSafeInteger(leader) && leader > 1);
  t.after(async () => {
    if (groupAlive(leader)) process.kill(-leader, 'SIGKILL');
    await manager.disposeAll();
  });
  assert(groupAlive(leader));
  await stopExecutionHandles(conversationId);
  assert.equal(groupAlive(leader), false, 'the original process group still exists after stop');
  assert.equal(executionHandlesLive(conversationId), false);
  const next = await manager.runCommand({ conversationId, toolCallId: 'next-call', command: 'printf ready', timeoutMs: 5000 });
  assert.equal(next.stdout, 'ready');
  assert.equal(next.sessionRebuilt, true);
});

test('an exited Shell leader drains children still holding its output pipes', posixOnly, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-drain-shell-pipes-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const manager = createNodeShellSessionManager({ workspaceRoot, shellPath: '/bin/sh', killGraceMs: 80 });
  t.after(() => manager.disposeAll());
  const conversationId = 'shell-open-pipe-stop';
  const result = await manager.runCommand({
    conversationId, toolCallId: 'exit-shell', timeoutMs: 5000,
    command: `printf '%s\\n' "$$" > leader
/bin/sh -c 'trap "" INT TERM; : > ready; exec /bin/sleep 30' &
while [ ! -f ready ]; do /bin/sleep 0.01; done
printf 'last output'
exit`,
  });
  assert.equal(result.exitCode, null, 'no command completion trailer was written');
  assert.equal(result.stdout, 'last output');
  const leader = Number(await readFile(path.join(workspaceRoot, 'leader'), 'utf8'));
  assert(Number.isSafeInteger(leader) && leader > 1);
  t.after(() => { try { process.kill(-leader, 'SIGKILL'); } catch {} });
  await manager.disposeConversation(conversationId);
  assert.throws(() => process.kill(-leader, 0), { code: 'ESRCH' });
  assert.equal(executionHandlesLive(conversationId), false);
});

function createManager(t: test.TestContext, workspaceRoot: string) {
  const manager = createNodeShellSessionManager({ workspaceRoot });
  t.after(() => manager.disposeAll());
  return manager;
}

test('queued dispatch rechecks authority and a denied command does not consume session bootstrap', posixOnly, async t => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-authority-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const manager = createNodeShellSessionManager({ workspaceRoot, bootstrapScript: 'export PEER_BOOTSTRAP_MARK=ready' });
  t.after(() => manager.disposeAll());
  await assert.rejects(manager.runCommand({ command: 'touch forbidden', timeoutMs: 5000,
    beforeExecute: () => { throw new Error('permission_policy_changed'); } }), /permission_policy_changed/);
  assert.equal(existsSync(path.join(workspaceRoot, 'forbidden')), false);
  const allowed = await manager.runCommand({ command: 'printf "$PEER_BOOTSTRAP_MARK"', timeoutMs: 5000 });
  assert.equal(allowed.status, 'completed'); assert.equal(allowed.stdout, 'ready');
});

test('session manager keeps cwd and env across foreground commands', posixOnly, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-session-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const nested = path.join(workspaceRoot, 'nested');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(nested));
  const manager = createManager(t, workspaceRoot);

  const first = await manager.runCommand({
    conversationId: 'conv-1',
    command: 'cd nested && export PEER_SESSION_MARK=alive',
    timeoutMs: 5_000,
  });
  assert.equal(first.status, 'completed');
  assert.equal(realpathSync(first.cwd), realpathSync(nested));

  const second = await manager.runCommand({
    conversationId: 'conv-1',
    command: 'printf "%s %s" "$PEER_SESSION_MARK" "$(basename "$(pwd)")"',
    timeoutMs: 5_000,
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.stdout, 'alive nested');
  assert.equal(second.sessionRebuilt, false);
});

test('session manager isolates conversations and command evidence', posixOnly, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-session-iso-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const manager = createManager(t, workspaceRoot);

  const first = await manager.runCommand({
    conversationId: 'alpha',
    command: 'printf first-only',
    timeoutMs: 5_000,
  });
  const second = await manager.runCommand({
    conversationId: 'alpha',
    command: 'printf second-only',
    timeoutMs: 5_000,
  });
  const other = await manager.runCommand({
    conversationId: 'beta',
    command: 'printf other-session',
    timeoutMs: 5_000,
  });

  assert.equal(first.stdout, 'first-only');
  assert.equal(second.stdout, 'second-only');
  assert.equal(other.stdout, 'other-session');
  assert.doesNotMatch(first.stdout, /second-only/);
  assert.doesNotMatch(second.stdout, /first-only/);
});

test('session manager serializes concurrent commands on one conversation', posixOnly, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-session-serial-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await writeFile(path.join(workspaceRoot, 'order.txt'), '', 'utf8');
  const manager = createManager(t, workspaceRoot);

  const [first, second] = await Promise.all([
    manager.runCommand({
      conversationId: 'serial',
      command: 'printf a >> order.txt && sleep 0.05 && printf b >> order.txt',
      timeoutMs: 5_000,
    }),
    manager.runCommand({
      conversationId: 'serial',
      command: 'printf c >> order.txt',
      timeoutMs: 5_000,
    }),
  ]);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  const order = await import('node:fs/promises').then(({ readFile }) => (
    readFile(path.join(workspaceRoot, 'order.txt'), 'utf8')
  ));
  assert.equal(order, 'abc');
});

test('session manager rebuilds after timeout', posixOnly, async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-session-timeout-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const manager = createManager(t, workspaceRoot);

  const timedOut = await manager.runCommand({
    conversationId: 'timeout',
    command: 'sleep 5',
    timeoutMs: 40,
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.timedOut, true);

  const recovered = await manager.runCommand({
    conversationId: 'timeout',
    command: 'printf recovered',
    timeoutMs: 5_000,
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.stdout, 'recovered');
  assert.equal(recovered.sessionRebuilt, true);
});
