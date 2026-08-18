import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeShellSessionManager } from './shell-session.ts';

const posixOnly = process.platform === 'win32' ? { skip: 'POSIX persistent shell only' } : {};

function createManager(t: test.TestContext, workspaceRoot: string) {
  const manager = createNodeShellSessionManager({ workspaceRoot });
  t.after(() => manager.disposeAll());
  return manager;
}

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
