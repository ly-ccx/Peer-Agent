import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeSdk } from './runtime.ts';
import type {
  RuntimeSdkEvent,
  RuntimeSdkHostAdapter,
  RuntimeSdkToolResult,
} from './contracts.ts';

const request = {
  sessionId: 'session-1',
  call: {
    toolCallId: 'tool-1',
    capabilityId: 'local.test',
    arguments: { value: 1 },
  },
};

function completedResult(): RuntimeSdkToolResult {
  return {
    toolCallId: 'tool-1',
    status: 'completed',
    evidence: { evidenceId: 'evidence-1' },
  };
}

function createHost(overrides: Partial<RuntimeSdkHostAdapter> = {}): RuntimeSdkHostAdapter {
  return {
    executeProvider: async () => ({
      result: completedResult(),
      grant: { granted: true },
    }),
    createBlockedExecution: ({ request: blockedRequest, reason }) => ({
      call: blockedRequest.call,
      grant: { granted: false },
      result: {
        toolCallId: blockedRequest.call.toolCallId,
        status: 'failed',
        reason,
      },
    }),
    appendHookEvidence: (result, records, finalDecision) => ({
      ...result,
      evidence: {
        ...(typeof result.evidence === 'object' && result.evidence ? result.evidence : {}),
        hooks: records,
        hookFinalDecision: finalDecision,
      },
    }),
    ...overrides,
  };
}

function eventTypes(events: readonly RuntimeSdkEvent[]): string[] {
  return events.map((event) => event.type);
}

test('runs hooks, provider, evidence and events in the public execution order', async () => {
  const calls: string[] = [];
  const events: RuntimeSdkEvent[] = [];
  const runtime = createRuntimeSdk({
    now: () => '2026-07-10T00:00:00.000Z',
    host: createHost({
      hookRunner: {
        runPreToolUse: () => {
          calls.push('pre');
          return [{ hookId: 'pre-allow', decision: 'allow' }];
        },
        runPostToolUse: () => {
          calls.push('post');
          return [{ hookId: 'post-audit', decision: 'allow' }];
        },
      },
      executeProvider: async () => {
        calls.push('provider');
        return { result: completedResult() };
      },
    }),
  });
  runtime.subscribe((event) => events.push(event));

  const execution = await runtime.execute(request);

  assert.deepEqual(calls, ['pre', 'provider', 'post']);
  assert.deepEqual(eventTypes(events), [
    'tool.started',
    'hook.completed',
    'hook.completed',
    'tool.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events.map((event) => event.protocolVersion), [1, 1, 1, 1]);
  assert.equal(events[0]?.sessionId, 'session-1');
  assert.equal(events[1]?.type === 'hook.completed' ? events[1].phase : undefined, 'PreToolUse');
  assert.equal(events[2]?.type === 'hook.completed' ? events[2].phase : undefined, 'PostToolUse');
  assert.equal((execution.result.evidence as { hookFinalDecision?: string }).hookFinalDecision, 'allow');
  assert.equal((execution.result.evidence as { hooks?: unknown[] }).hooks?.length, 2);
});

test('deny is the most restrictive pre-hook decision and prevents provider execution', async () => {
  let providerCalls = 0;
  const events: RuntimeSdkEvent[] = [];
  const runtime = createRuntimeSdk({
    host: createHost({
      hookRunner: {
        runPreToolUse: () => [
          { hookId: 'allow', decision: 'allow' },
          { hookId: 'deny', decision: 'deny', reason: 'blocked by policy' },
          { hookId: 'ask', decision: 'ask' },
        ],
      },
      executeProvider: async () => {
        providerCalls += 1;
        return { result: completedResult() };
      },
    }),
  });
  runtime.subscribe((event) => events.push(event));

  const execution = await runtime.execute(request);

  assert.equal(providerCalls, 0);
  assert.equal(execution.result.reason, 'blocked by policy');
  assert.equal((execution.result.evidence as { hookFinalDecision?: string }).hookFinalDecision, 'deny');
  assert.deepEqual(eventTypes(events), ['tool.started', 'hook.completed', 'tool.completed']);
  const completedEvent = events.at(-1);
  assert.equal(completedEvent?.type === 'tool.completed' ? completedEvent.decision : undefined, 'deny');
});

test('ask enters approval flow and runs provider only after allow', async () => {
  const calls: string[] = [];
  const events: RuntimeSdkEvent[] = [];
  const runtime = createRuntimeSdk({
    host: createHost({
      hookRunner: {
        runPreToolUse: () => [{ hookId: 'ask', decision: 'ask', reason: 'confirm' }],
      },
      approvalPort: {
        requestApproval: (approvalRequest) => {
          calls.push('approval');
          assert.equal(approvalRequest.call, request.call);
          assert.equal(approvalRequest.reason, 'confirm');
          return { decision: 'allow' };
        },
      },
      executeProvider: async () => {
        calls.push('provider');
        return { result: completedResult() };
      },
    }),
  });
  runtime.subscribe((event) => events.push(event));

  await runtime.execute(request);

  assert.deepEqual(calls, ['approval', 'provider']);
  assert.deepEqual(eventTypes(events), [
    'tool.started',
    'hook.completed',
    'permission.requested',
    'permission.resolved',
    'hook.completed',
    'tool.completed',
  ]);
  assert.equal(events[3]?.type === 'permission.resolved' ? events[3].decision : undefined, 'allow');
});

test('ask fails closed when approval is unavailable', async () => {
  let providerCalls = 0;
  const runtime = createRuntimeSdk({
    host: createHost({
      hookRunner: {
        runPreToolUse: () => [{ hookId: 'ask', decision: 'ask' }],
      },
      executeProvider: async () => {
        providerCalls += 1;
        return { result: completedResult() };
      },
    }),
  });

  const execution = await runtime.execute(request);

  assert.equal(providerCalls, 0);
  assert.equal(execution.result.reason, 'hook_approval_required');
  assert.equal((execution.result.evidence as { hookFinalDecision?: string }).hookFinalDecision, 'ask');
});

test('unsubscribe stops subsequent event delivery', async () => {
  const events: RuntimeSdkEvent[] = [];
  const runtime = createRuntimeSdk({ host: createHost() });
  const unsubscribe = runtime.subscribe((event) => events.push(event));

  await runtime.execute(request);
  const firstRunCount = events.length;
  unsubscribe();
  await runtime.execute({
    ...request,
    call: { ...request.call, toolCallId: 'tool-2' },
  });

  assert.equal(events.length, firstRunCount);
});
