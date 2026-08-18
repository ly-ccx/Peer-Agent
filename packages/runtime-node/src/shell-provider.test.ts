import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectToolEvidenceRefs,
  type CapabilityExecutionContext,
  type CapabilityRequest,
} from '@peer-agent/runtime-core';

import type { NodeCapabilityPermissionPrompt } from './provider-contracts.ts';
import { classifyNodeShellCommand } from './shell-classifier.ts';
import { createNodeShellProvider } from './shell-provider.ts';
import { createNodeShellTaskManager } from './shell-task-manager.ts';

function request(command: string, extra: Record<string, unknown> = {}): CapabilityRequest {
  return {
    capabilityId: 'local.shell.exec',
    toolCall: {
      toolCallId: `call-${command}`,
      capabilityId: 'local.shell.exec',
      input: { command, ...extra },
    },
    input: { command, ...extra },
  };
}

function stopRequest(taskId: string, reason?: string): CapabilityRequest {
  const input = { taskId, ...(reason ? { reason } : {}) };
  return {
    capabilityId: 'local.shell.stop',
    toolCall: {
      toolCallId: `call-stop-${taskId}`,
      capabilityId: 'local.shell.stop',
      input,
    },
    input,
  };
}

function context(
  signal?: AbortSignal,
  conversationId = 'session-1',
): CapabilityExecutionContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    workspace: { root: '/workspace' },
    signal,
    metadata: { conversationId },
  };
}

function createProvider(
  t: test.TestContext,
  options: Parameters<typeof createNodeShellProvider>[0],
) {
  const provider = createNodeShellProvider(options);
  t.after(() => provider.dispose());
  return provider;
}

test('shell classifier preserves allow, ask, deny, and allows cwd outside workspace', () => {
  const workspaceRoot = path.resolve('/workspace');
  assert.equal(classifyNodeShellCommand({ command: 'printf hello', workspaceRoot }).decision, 'allow');
  assert.equal(classifyNodeShellCommand({ command: 'touch file.txt', workspaceRoot }).decision, 'ask');
  const destructive = classifyNodeShellCommand({ command: 'rm -rf .', workspaceRoot });
  assert.equal(destructive.decision, 'deny');
  assert.equal(destructive.riskLevel, 'L5_destructive');
  // Product decision: no cwd hard sandbox; outside cwd is resolved and classified normally.
  const outside = classifyNodeShellCommand({ command: 'pwd', cwd: '../outside', workspaceRoot });
  assert.equal(outside.decision, 'allow');
  assert.ok(outside.cwd.endsWith(`${path.sep}outside`) || outside.cwd.endsWith('/outside'));
});

test('shell provider auto-allows read-only commands and records Evidence', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  let approvalCalls = 0;
  const provider = createProvider(t, {
    workspaceRoot,
    requestApproval() {
      approvalCalls += 1;
      return { granted: false, reason: 'should_not_be_called' };
    },
  });

  const result = await provider.execute(request('printf hello'), context());
  assert.equal(result.status, 'completed');
  assert.equal((result.output as { stdout?: string }).stdout, 'hello');
  assert.equal(result.permissionGrant?.decision, 'allow');
  assert.equal(approvalCalls, 0);
  assert.ok(result.evidence);
});

test('shell provider requires capability approval for risky commands', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-approval-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const prompts: NodeCapabilityPermissionPrompt[] = [];
  let granted = false;
  const provider = createProvider(t, {
    workspaceRoot,
    requestApproval(prompt) {
      prompts.push(prompt);
      return granted
        ? { granted: true, reason: 'approved_for_test' }
        : { granted: false, reason: 'denied_for_test' };
    },
  });

  const denied = await provider.execute(request('touch approved.txt'), context());
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error?.code, 'denied_for_test');
  assert.equal(prompts[0]?.confirmation.approvalKind, 'shell-exec');

  granted = true;
  const completed = await provider.execute(request('touch approved.txt'), context());
  assert.equal(completed.status, 'completed');
  assert.equal(completed.permissionGrant?.decision, 'allow');
  assert.equal(completed.permissionGrant?.reason, 'approved_shell_execution');
});

test('shell provider hard-denies destructive commands without asking', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-deny-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  let approvalCalls = 0;
  const provider = createProvider(t, {
    workspaceRoot,
    requestApproval() {
      approvalCalls += 1;
      return { granted: true };
    },
  });

  const result = await provider.execute(request('rm -rf .'), context());
  assert.equal(result.status, 'denied');
  assert.equal(result.permissionGrant?.decision, 'deny');
  assert.equal((result.metadata as { riskLevel?: string }).riskLevel, 'L5_destructive');
  assert.equal(approvalCalls, 0);
});

test('shell provider terminates on AbortSignal and timeout', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-cancel-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const provider = createProvider(t, {
    workspaceRoot,
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 5000,
    requestApproval: () => ({ granted: true }),
  });

  const controller = new AbortController();
  const running = provider.execute(
    request('node -e "setTimeout(() => {}, 10000)"'),
    context(controller.signal),
  );
  setTimeout(() => controller.abort(), 50);
  const cancelled = await running;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.evidence);

  const timedOut = await provider.execute(
    request('node -e "setTimeout(() => {}, 10000)"', { timeoutMs: 40 }),
    context(),
  );
  assert.equal(timedOut.status, 'timeout');
  assert.equal((timedOut.output as { timedOut?: boolean }).timedOut, true);
});

test('shell provider starts and stops a background task through one scoped manager', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-background-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const taskManager = createNodeShellTaskManager({
    workspaceRoot,
    artifactRoot: path.join(workspaceRoot, 'artifacts'),
    killGraceMs: 20,
  });
  const taskIds: string[] = [];
  t.after(async () => {
    await Promise.all(taskIds.map((taskId) => taskManager.stopTask(taskId, 'test_cleanup')));
  });
  let approvalCalls = 0;
  const provider = createProvider(t, {
    workspaceRoot,
    taskManager,
    requestApproval() {
      approvalCalls += 1;
      return { granted: true };
    },
  });

  const started = await provider.execute(
    request(`node -e "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"`, {
      background: true,
      timeoutMs: 10_000,
    }),
    context(),
  );
  assert.equal(started.status, 'completed');
  const startedOutput = started.output as {
    taskId: string;
    status: string;
    artifactRef: string;
    artifactRefs: string[];
  };
  taskIds.push(startedOutput.taskId);
  assert.match(startedOutput.taskId, /^shell_[0-9a-f-]{36}$/i);
  assert.equal(startedOutput.status, 'running');
  assert.equal(startedOutput.artifactRef, `local-shell-artifact://${startedOutput.taskId}`);
  const executionEvidenceRefs = collectToolEvidenceRefs({
    toolCallId: started.toolCallId,
    execution: { result: started },
  });
  assert.deepEqual(executionEvidenceRefs, [
    `tool-result://${started.toolCallId}`,
    ...startedOutput.artifactRefs,
    startedOutput.artifactRef,
  ]);
  assert.equal(taskManager.getTask(startedOutput.taskId)?.status, 'running');
  assert.equal(approvalCalls, 1);

  const stopped = await provider.execute(stopRequest(startedOutput.taskId, 'provider_test'), context());
  assert.equal(stopped.status, 'completed');
  const stoppedOutput = stopped.output as {
    taskId: string;
    stopped: boolean;
    status: string;
    reason: string;
    artifactRef: string;
    artifactRefs: string[];
  };
  assert.equal(stoppedOutput.taskId, startedOutput.taskId);
  assert.equal(stoppedOutput.stopped, true);
  assert.equal(stoppedOutput.status, 'cancelled');
  assert.equal(stoppedOutput.reason, 'provider_test');
  assert.equal(stoppedOutput.artifactRef, startedOutput.artifactRef);
  assert.deepEqual(stoppedOutput.artifactRefs, startedOutput.artifactRefs);
  assert.equal(approvalCalls, 1);

  const repeated = await provider.execute(stopRequest(startedOutput.taskId), context());
  assert.equal(repeated.status, 'completed');
  assert.equal((repeated.output as { stopped: boolean }).stopped, false);

  const missing = await provider.execute(
    stopRequest('shell_00000000-0000-4000-8000-000000000000'),
    context(),
  );
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error?.code, 'shell_task_not_found');
});

test('shell provider rejects malformed task ids without exposing process control', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-invalid-stop-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const provider = createProvider(t, { workspaceRoot });
  const result = await provider.execute(stopRequest('1234'), context());
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'invalid_task_id');
});

test('shell provider keeps cwd after a deny and isolates command evidence', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-shell-persist-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(workspaceRoot, 'nested')));
  const provider = createProvider(t, {
    workspaceRoot,
    requestApproval: () => ({ granted: true }),
  });

  const moved = await provider.execute(request('cd nested && export PEER_MARK=kept'), context());
  assert.equal(moved.status, 'completed');

  const denied = await provider.execute(request('rm -rf .'), context());
  assert.equal(denied.status, 'denied');

  const persisted = await provider.execute(
    request('printf "%s %s" "$PEER_MARK" "$(basename "$(pwd)")"'),
    context(),
  );
  assert.equal(persisted.status, 'completed');
  assert.equal((persisted.output as { stdout?: string }).stdout, 'kept nested');
  assert.equal((persisted.metadata as { persistentSession?: boolean }).persistentSession, true);
  assert.doesNotMatch(String((moved.output as { stdout?: string }).stdout ?? ''), /kept nested/);

  const other = await provider.execute(
    request('printf other-conversation'),
    context(undefined, 'other-conversation'),
  );
  assert.equal((other.output as { stdout?: string }).stdout, 'other-conversation');
  assert.doesNotMatch(String((other.output as { stdout?: string }).stdout ?? ''), /kept nested/);
});
