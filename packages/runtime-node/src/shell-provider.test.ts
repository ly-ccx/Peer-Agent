import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CapabilityExecutionContext, CapabilityRequest } from '@peer-agent/runtime-core';

import type { NodeCapabilityPermissionPrompt } from './provider-contracts.ts';
import { classifyNodeShellCommand } from './shell-classifier.ts';
import { createNodeShellProvider } from './shell-provider.ts';

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

function context(signal?: AbortSignal): CapabilityExecutionContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    workspace: { root: '/workspace' },
    signal,
  };
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
  const provider = createNodeShellProvider({
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
  const provider = createNodeShellProvider({
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
  const provider = createNodeShellProvider({
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
  const provider = createNodeShellProvider({
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
