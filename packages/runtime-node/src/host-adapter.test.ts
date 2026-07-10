import assert from 'node:assert/strict';
import test from 'node:test';

import { createNodeRuntimeHostAdapter } from './host-adapter.ts';
import type { NodeRuntimePermissionPrompt } from './contracts.ts';

const request = {
  sessionId: 'session-1',
  projectionId: 'projection-1',
  conversationId: 'conversation-1',
  call: {
    toolCallId: 'tool-1',
    capabilityId: 'local.test',
    displayName: 'Test Tool',
    arguments: { value: 1 },
    riskLevel: 'L2_local_write',
    dataLevel: 'D1_internal',
  },
};

function createResultFactory() {
  return {
    createPermissionGrant: ({ toolCallId, granted, scope }: { toolCallId: string; granted: boolean; scope: string }) => ({
      grantId: `grant-${toolCallId}`,
      granted,
      scope,
    }),
    createFailedResult: ({ call, locale, reason, dataLevel }: {
      call: typeof request.call;
      locale?: string;
      reason: string;
      dataLevel: unknown;
    }) => ({
      toolCallId: call.toolCallId,
      status: 'failed',
      locale,
      reason,
      dataLevel,
    }),
  };
}

test('enriches provider execution with session and request identifiers', async () => {
  let receivedContext: Record<string, unknown> | undefined;
  const adapter = createNodeRuntimeHostAdapter({
    workspaceRoot: '/workspace',
    sessionProvider: { getSession: () => ({ locale: 'zh-CN', tenantId: 'tenant-1' }) },
    resultFactory: createResultFactory(),
    providerExecutor: {
      execute: async (_request, context) => {
        receivedContext = context;
        return { result: { toolCallId: 'tool-1', status: 'completed' } };
      },
    },
  });

  await adapter.executeProvider(request, { traceId: 'trace-1' });

  assert.equal(receivedContext?.locale, 'zh-CN');
  assert.equal(receivedContext?.workspaceRoot, '/workspace');
  assert.equal(receivedContext?.sessionId, 'session-1');
  assert.equal(receivedContext?.projectionId, 'projection-1');
  assert.equal(receivedContext?.conversationId, 'conversation-1');
  assert.equal((receivedContext?.session as { tenantId?: string }).tenantId, 'tenant-1');
  assert.equal(receivedContext?.traceId, 'trace-1');
});

test('creates unsupported capability fallback when no provider handles the call', async () => {
  const adapter = createNodeRuntimeHostAdapter({
    sessionProvider: { getSession: () => ({ locale: 'en-US' }) },
    resultFactory: createResultFactory(),
    providerExecutor: { execute: async () => null },
  });

  const execution = await adapter.executeProvider(request, {});

  assert.equal(execution.result.status, 'failed');
  assert.equal(execution.result.reason, 'unsupported_local_capability');
  assert.equal(execution.result.locale, 'en-US');
  assert.equal(execution.result.dataLevel, 'D1_internal');
  assert.deepEqual(execution.grant, {
    grantId: 'grant-tool-1',
    granted: false,
    scope: 'local.test',
  });
});

test('translates hook approval and preserves denied approval output', async () => {
  const deniedGrant = { grantId: 'denied-1', granted: false };
  let prompt: NodeRuntimePermissionPrompt | undefined;
  const adapter = createNodeRuntimeHostAdapter({
    workspaceRoot: '/workspace',
    sessionProvider: { getSession: () => ({ locale: 'zh-CN' }) },
    resultFactory: createResultFactory(),
    providerExecutor: { execute: async () => null },
  });
  const permissionRequest = {
    kind: 'hook' as const,
    hookEvent: 'PreToolUse' as const,
    call: request.call,
    toolCallId: 'tool-1',
    capabilityId: 'local.test',
    args: request.call.arguments,
    reason: 'confirm this tool',
  };

  const decision = await adapter.approvalPort!.requestApproval(permissionRequest, {
    requestPermission: async (nextPrompt: NodeRuntimePermissionPrompt) => {
      prompt = nextPrompt;
      return { granted: false, grant: deniedGrant, reason: 'user_denied' };
    },
  });
  const blocked = adapter.createBlockedExecution({
    request,
    context: {},
    decision: decision.decision,
    reason: 'hook_approval_denied',
    approval: decision,
  });

  assert.equal(prompt?.toolName, 'Test Tool');
  assert.equal(prompt?.workspacePath, '/workspace');
  assert.equal(prompt?.confirmation.hookEvent, 'PreToolUse');
  assert.equal(prompt?.riskLevel, 'L2_local_write');
  assert.equal(decision.decision, 'deny');
  assert.equal(blocked.grant, deniedGrant);
  assert.equal(blocked.result.reason, 'user_denied');
});

test('fails closed when approval port has no host permission callback', async () => {
  const adapter = createNodeRuntimeHostAdapter({
    sessionProvider: { getSession: () => ({ locale: 'en-US' }) },
    resultFactory: createResultFactory(),
    providerExecutor: { execute: async () => null },
  });
  const decision = await adapter.approvalPort!.requestApproval({
    kind: 'hook',
    hookEvent: 'PreToolUse',
    call: request.call,
    toolCallId: 'tool-1',
    capabilityId: 'local.test',
    args: {},
    reason: 'confirm',
  }, {});

  assert.equal(decision.decision, 'ask');
  const blocked = adapter.createBlockedExecution({
    request,
    context: {},
    decision: 'ask',
    reason: 'hook_approval_required',
    approval: decision,
  });
  assert.equal(blocked.result.reason, 'hook_approval_required');
});
