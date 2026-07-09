import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalToolHost } from './local-tool-host.mjs';
import { createPermissionGrant } from './tool-result-factory.mjs';

function createSessionStore() {
  return { getSession: () => ({ locale: 'en-US' }) };
}

function createRequest(capabilityId = 'test.echo') {
  return {
    sessionId: 'session-1',
    projectionId: 'projection-1',
    conversationId: 'conversation-1',
    call: {
      toolCallId: 'tool-call-1',
      capabilityId,
      arguments: { text: 'hello' },
      dataLevel: 'D0_public',
    },
  };
}

function createEchoProvider({ calls }) {
  return {
    providerId: 'test-provider',
    capabilityIds: ['test.echo'],
    async executeCapability(request) {
      calls.count += 1;
      const { call } = request;
      return {
        call,
        grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: true, scope: call.capabilityId }),
        result: {
          toolCallId: call.toolCallId,
          status: 'success',
          outputPreview: { text: call.arguments.text },
          dataLevel: 'D0_public',
          artifactRefs: [],
          evidence: {
            evidenceId: 'evidence-1',
            toolCallId: call.toolCallId,
            summary: 'echoed',
            locale: 'en-US',
            returnedToCloud: false,
            dataLevel: 'D0_public',
            redactions: [],
            artifactRefs: [],
          },
          completedAt: '2026-07-09T00:00:00.000Z',
        },
      };
    },
  };
}

test('PreToolUse deny blocks provider execution and records hook evidence', async () => {
  const calls = { count: 0 };
  const host = createLocalToolHost({
    sessionStore: createSessionStore(),
    workspaceRoot: process.cwd(),
    userDataPath: process.cwd(),
    providers: [createEchoProvider({ calls })],
    hookRunner: {
      runPreToolUse: async () => [{ id: 'deny', event: 'PreToolUse', decision: 'deny', reason: 'blocked', outcome: 'ok', durationMs: 1 }],
      runPostToolUse: async () => [{ id: 'post', event: 'PostToolUse', decision: 'allow', outcome: 'ok', durationMs: 1 }],
    },
  });

  const execution = await host.execute(createRequest());
  assert.equal(calls.count, 0);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.outputPreview.reason, 'hook_denied');
  assert.equal(execution.result.evidence.hookFinalDecision, 'deny');
  assert.equal(execution.result.evidence.hooks.length, 1);
  assert.equal(execution.result.evidence.hooks[0].id, 'deny');
});

test('PreToolUse ask enters permission flow and executes after approval', async () => {
  const calls = { count: 0 };
  const permissionRequests = [];
  const host = createLocalToolHost({
    sessionStore: createSessionStore(),
    workspaceRoot: process.cwd(),
    userDataPath: process.cwd(),
    providers: [createEchoProvider({ calls })],
    hookRunner: {
      runPreToolUse: async () => [{ id: 'ask', event: 'PreToolUse', decision: 'ask', reason: 'needs approval', outcome: 'ok', durationMs: 1 }],
      runPostToolUse: async () => [{ id: 'post', event: 'PostToolUse', decision: 'allow', outcome: 'ok', durationMs: 1 }],
    },
  });

  const execution = await host.execute(createRequest(), {
    requestPermission: async (request) => {
      permissionRequests.push(request);
      return {
        granted: true,
        grant: createPermissionGrant({ toolCallId: 'tool-call-1', granted: true, scope: 'test.echo' }),
        reason: 'local_user_approved_once',
      };
    },
  });
  assert.equal(calls.count, 1);
  assert.equal(permissionRequests.length, 1);
  assert.equal(permissionRequests[0].confirmation.kind, 'hook-approval');
  assert.equal(permissionRequests[0].reason, 'needs approval');
  assert.equal(execution.grant.granted, true);
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.evidence.hookFinalDecision, 'ask');
  assert.deepEqual(execution.result.evidence.hooks.map((hook) => hook.id), ['ask', 'post']);
});

test('PreToolUse ask fails closed when approval is unavailable', async () => {
  const calls = { count: 0 };
  const host = createLocalToolHost({
    sessionStore: createSessionStore(),
    workspaceRoot: process.cwd(),
    userDataPath: process.cwd(),
    providers: [createEchoProvider({ calls })],
    hookRunner: {
      runPreToolUse: async () => [{ id: 'ask', event: 'PreToolUse', decision: 'ask', reason: 'needs approval', outcome: 'ok', durationMs: 1 }],
      runPostToolUse: async () => [{ id: 'post', event: 'PostToolUse', decision: 'allow', outcome: 'ok', durationMs: 1 }],
    },
  });

  const execution = await host.execute(createRequest());
  assert.equal(calls.count, 0);
  assert.equal(execution.grant.granted, false);
  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.outputPreview.reason, 'hook_approval_required');
  assert.equal(execution.result.evidence.hookFinalDecision, 'ask');
  assert.deepEqual(execution.result.evidence.hooks.map((hook) => hook.id), ['ask']);
});

test('PostToolUse runs after provider execution and records hook evidence', async () => {
  const calls = { count: 0 };
  const host = createLocalToolHost({
    sessionStore: createSessionStore(),
    workspaceRoot: process.cwd(),
    userDataPath: process.cwd(),
    providers: [createEchoProvider({ calls })],
    hookRunner: {
      runPreToolUse: async () => [{ id: 'pre', event: 'PreToolUse', decision: 'allow', outcome: 'ok', durationMs: 1 }],
      runPostToolUse: async () => [{ id: 'post', event: 'PostToolUse', decision: 'allow', outcome: 'ok', durationMs: 2 }],
    },
  });

  const execution = await host.execute(createRequest());
  assert.equal(calls.count, 1);
  assert.equal(execution.grant.granted, true);
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.evidence.hookFinalDecision, 'allow');
  assert.deepEqual(execution.result.evidence.hooks.map((hook) => hook.id), ['pre', 'post']);
});
