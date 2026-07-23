import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeShellArtifactStore } from './shell-artifact-store.ts';
import { createNodeShellTaskManager } from './shell-task-manager.ts';

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function readWhenAvailable(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

test('shell task manager streams output into one artifact and finalizes metadata', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-task-'));
  const artifactRoot = path.join(workspaceRoot, 'artifacts');
  const manager = createNodeShellTaskManager({
    workspaceRoot,
    artifactStore: createNodeShellArtifactStore({ rootPath: artifactRoot }),
    killGraceMs: 20,
  });
  let taskId = '';
  t.after(async () => {
    if (taskId) await manager.stopTask(taskId, 'test_cleanup');
  });

  const task = await manager.runTask({
    toolCallId: 'call_stream',
    command: `node -e "process.stdout.write('first'); process.stderr.write('warn'); setTimeout(() => process.stdout.write(' second'), 80)"`,
    cwd: workspaceRoot,
    timeoutMs: 2_000,
    classification: { category: 'read' },
  });
  taskId = task.taskId;

  assert.match(task.taskId, /^shell_[0-9a-f-]{36}$/i);
  assert.equal(task.status, 'running');
  assert.equal(task.artifact.artifactRef, `local-shell-artifact://${task.taskId}`);
  await waitFor(async () => (await readWhenAvailable(task.artifact.stdoutPath)).includes('first'));
  assert.equal(manager.getTask(task.taskId)?.status, 'running');

  const output = await task.completion;
  assert.equal(output.status, 'completed');
  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout, 'first second');
  assert.equal(output.stderr, 'warn');
  assert.equal(output.artifact.artifactRef, task.artifact.artifactRef);
  assert.equal(await readFile(output.artifact.stdoutPath, 'utf8'), 'first second');
  assert.equal(await readFile(output.artifact.stderrPath, 'utf8'), 'warn');
  const metadata = JSON.parse(await readFile(output.artifact.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.taskId, task.taskId);
  assert.equal(metadata.toolCallId, 'call_stream');
  assert.equal(metadata.status, 'completed');
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.truncated, false);
});

test('shell task manager stops a running process group and reuses its artifact', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-stop-'));
  const manager = createNodeShellTaskManager({
    workspaceRoot,
    artifactRoot: path.join(workspaceRoot, 'artifacts'),
    killGraceMs: 20,
  });
  let taskId = '';
  t.after(async () => {
    if (taskId) await manager.stopTask(taskId, 'test_cleanup');
  });

  const task = await manager.runTask({
    toolCallId: 'call_background',
    command: `node -e "process.stdout.write('started\\n'); setInterval(() => process.stdout.write('tick\\n'), 25)"`,
    cwd: workspaceRoot,
    timeoutMs: 10_000,
  });
  taskId = task.taskId;
  await waitFor(async () => (await readWhenAvailable(task.artifact.stdoutPath)).includes('started'));

  const stopped = await manager.stopTask(task.taskId, 'manual_stop');
  assert.equal(stopped.found, true);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.reason, 'manual_stop');
  assert.equal(stopped.artifact?.artifactRef, task.artifact.artifactRef);
  assert.equal(stopped.output?.interrupted, true);
  assert.equal(stopped.output?.cancelled, true);
  assert.equal(stopped.output?.stopReason, 'manual_stop');

  const metadata = JSON.parse(
    await readFile(stopped.artifact!.metadataPath, 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(metadata.status, 'cancelled');
  assert.equal(metadata.stopReason, 'manual_stop');
  assert.equal(metadata.interrupted, true);

  const repeated = await manager.stopTask(task.taskId, 'again');
  assert.equal(repeated.found, true);
  assert.equal(repeated.stopped, false);
  assert.equal(repeated.reason, 'task_not_running');
  assert.equal(repeated.artifact?.artifactRef, task.artifact.artifactRef);

  const missing = await manager.stopTask('shell_00000000-0000-4000-8000-000000000000');
  assert.deepEqual(missing, {
    found: false,
    stopped: false,
    taskId: 'shell_00000000-0000-4000-8000-000000000000',
    status: 'not_found',
    reason: 'task_not_found',
  });
});

test('shell task manager routes AbortSignal and timeout through the same state machine', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-cancel-'));
  const manager = createNodeShellTaskManager({
    workspaceRoot,
    artifactRoot: path.join(workspaceRoot, 'artifacts'),
    killGraceMs: 20,
  });
  const taskIds: string[] = [];
  t.after(async () => {
    await Promise.all(taskIds.map((taskId) => manager.stopTask(taskId, 'test_cleanup')));
  });

  const controller = new AbortController();
  const aborted = await manager.runTask({
    toolCallId: 'call_abort',
    command: `node -e "setInterval(() => {}, 1_000)"`,
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  taskIds.push(aborted.taskId);
  controller.abort();
  const abortedOutput = await aborted.completion;
  assert.equal(abortedOutput.status, 'cancelled');
  assert.equal(abortedOutput.stopReason, 'aborted');
  assert.equal(abortedOutput.interrupted, true);
  assert.equal(abortedOutput.timedOut, false);

  const timedOut = await manager.runTask({
    toolCallId: 'call_timeout',
    command: `node -e "setInterval(() => {}, 1_000)"`,
    cwd: workspaceRoot,
    timeoutMs: 40,
  });
  taskIds.push(timedOut.taskId);
  const timedOutOutput = await timedOut.completion;
  assert.equal(timedOutOutput.status, 'timeout');
  assert.equal(timedOutOutput.stopReason, 'timeout');
  assert.equal(timedOutOutput.interrupted, true);
  assert.equal(timedOutOutput.timedOut, true);
  assert.equal(manager.listTasks().length, 2);
});

test('shell artifact store caps persisted streams without losing final metadata', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-shell-cap-'));
  const store = createNodeShellArtifactStore({
    rootPath: path.join(workspaceRoot, 'artifacts'),
    maxArtifactChars: 5,
  });
  const taskId = 'shell_00000000-0000-4000-8000-000000000001';
  const startedAt = new Date().toISOString();
  const artifact = await store.createTaskArtifact({
    taskId,
    toolCallId: 'call_cap',
    command: 'printf 123456789',
    cwd: workspaceRoot,
    workspaceRoot,
    startedAt,
  });
  await artifact.appendStdout('123456789');
  const descriptor = await artifact.finalize({
    taskId,
    toolCallId: 'call_cap',
    command: 'printf 123456789',
    cwd: workspaceRoot,
    workspaceRoot,
    startedAt,
    completedAt: new Date().toISOString(),
    status: 'completed',
  });

  assert.equal(descriptor.truncated, true);
  assert.equal(await readFile(descriptor.stdoutPath, 'utf8'), '12345\n...[artifact truncated]\n');
  const metadata = JSON.parse(await readFile(descriptor.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.status, 'completed');
  assert.equal(metadata.truncated, true);
});
