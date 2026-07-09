import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalShellProvider } from './local-shell-provider.mjs';

function createCall(command) {
  return {
    toolCallId: `shell-${Math.random().toString(16).slice(2)}`,
    capabilityId: 'local.shell.exec',
    reason: 'test shell hook merge',
    argumentsPreview: {
      command,
    },
  };
}

function createNoopTaskManager() {
  let ran = false;
  return {
    get ran() {
      return ran;
    },
    runTask() {
      ran = true;
      return {
        taskId: 'task-1',
        startedAt: new Date().toISOString(),
        completion: Promise.resolve({
          status: 'success',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          artifact: {
            artifactRefs: [],
          },
          completedAt: new Date().toISOString(),
        }),
      };
    },
    listTasks() {
      return [];
    },
    stopTask() {
      return { stopped: false, reason: 'shell_task_not_running' };
    },
    stopActiveTask() {
      return { stopped: false, reason: 'shell_task_not_running' };
    },
  };
}

function createProvider({ hookDecision, approvalDecider } = {}) {
  const taskManager = createNoopTaskManager();
  const workspaceRoot = mkdtempSync(join(os.tmpdir(), 'peer-shell-hook-'));
  const provider = createLocalShellProvider({
    workspaceRoot,
    userDataPath: workspaceRoot,
    approvalDecider,
    taskManager,
    hookRunner: {
      runPreToolUse: async (payload) => [
        {
          id: 'shell-hook',
          event: 'PreToolUse',
          decision: hookDecision,
          reason: `hook_${hookDecision}`,
          outcome: 'ok',
          durationMs: 1,
          payload,
        },
      ],
    },
  });
  return { provider, taskManager };
}

test('shell hook allow cannot loosen destructive command deny', async () => {
  const { provider, taskManager } = createProvider({ hookDecision: 'allow' });

  const execution = await provider.executeCapability(
    { call: createCall('git reset --hard') },
    { locale: 'en-US' },
  );

  assert.equal(taskManager.ran, false);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'denied');
  assert.equal(execution.result.outputPreview.reason, 'local_user_approval_required');
  assert.equal(execution.result.evidence.hookFinalDecision, 'allow');
  assert.deepEqual(execution.result.evidence.hooks.map((hook) => hook.id), ['shell-hook']);
});

test('shell hook deny blocks read-only command that would otherwise run', async () => {
  const { provider, taskManager } = createProvider({ hookDecision: 'deny' });

  const execution = await provider.executeCapability(
    { call: createCall('pwd') },
    { locale: 'en-US' },
  );

  assert.equal(taskManager.ran, false);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'denied');
  assert.equal(execution.result.outputPreview.reason, 'hook_deny');
  assert.equal(execution.result.evidence.hookFinalDecision, 'deny');
});

test('shell hook allow cannot bypass existing ask decision', async () => {
  const { provider, taskManager } = createProvider({ hookDecision: 'allow' });

  const execution = await provider.executeCapability(
    { call: createCall('npm test') },
    { locale: 'en-US' },
  );

  assert.equal(taskManager.ran, false);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'denied');
  assert.equal(execution.result.outputPreview.reason, 'local_user_approval_required');
  assert.equal(execution.result.evidence.hookFinalDecision, 'allow');
});

test('shell hook ask stays in approval path and can be denied by local approval', async () => {
  const { provider, taskManager } = createProvider({
    hookDecision: 'ask',
    approvalDecider: async () => ({ granted: false, reason: 'user_rejected' }),
  });

  const execution = await provider.executeCapability(
    { call: createCall('pwd') },
    { locale: 'en-US' },
  );

  assert.equal(taskManager.ran, false);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'denied');
  assert.equal(execution.result.outputPreview.reason, 'user_rejected');
  assert.equal(execution.result.evidence.hookFinalDecision, 'ask');
});
