import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSdkEvent, RuntimeSdkEventInput } from './contracts.ts';
import type {
  RuntimePipelineToolCall,
  RuntimePipelineToolExecution,
} from './pipeline-contracts.ts';
import { createRuntimePipeline } from './pipeline.ts';
import { createRuntimeSdk } from './runtime.ts';

type State = {
  readonly phase: number;
  readonly transcript: readonly string[];
};

type ToolCall = RuntimePipelineToolCall & {
  readonly name: string;
};

type ToolResult = { readonly output: string };

function createEventSink(events: RuntimeSdkEvent[]) {
  let sequence = 0;
  return {
    emit(input: RuntimeSdkEventInput): RuntimeSdkEvent {
      sequence += 1;
      const event = {
        ...input,
        eventId: `event-${sequence}`,
        occurredAt: new Date(sequence * 1000).toISOString(),
      } as RuntimeSdkEvent;
      events.push(event);
      return event;
    },
  };
}

test('runs text-only model turns to completion without a host dependency', async () => {
  const events: RuntimeSdkEvent[] = [];
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult, string>({
    events: createEventSink(events),
    model: {
      initialize: ({ input }) => ({ phase: 0, transcript: [input] }),
      runTurn: async (state, context) => {
        context.emit({
          type: 'message.delta',
          sessionId: context.run.sessionId,
          streamId: context.run.streamId || 'stream-1',
          content: 'done',
        });
        return { kind: 'completed', state, output: 'done' };
      },
      applyToolResults: (state) => state,
    },
    tools: {
      execute: async () => {
        throw new Error('tool executor should not run');
      },
    },
  });

  const result = await pipeline.run({
    sessionId: 'session-1',
    streamId: 'stream-1',
    input: 'hello',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
  assert.equal(result.turns, 1);
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(events.map((event) => event.type), [
    'session.started',
    'message.delta',
    'message.completed',
  ]);
});

test('feeds ordered tool executions back into the model before the next turn', async () => {
  const order: string[] = [];
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult, string>({
    model: {
      initialize: ({ input }) => ({ phase: 0, transcript: [input] }),
      runTurn: async (state) => {
        if (state.phase === 0) {
          return {
            kind: 'tool_calls',
            state: { ...state, phase: 1 },
            calls: [
              { toolCallId: 'tool-1', capabilityId: 'local.one', name: 'one' },
              { toolCallId: 'tool-2', capabilityId: 'local.two', name: 'two' },
            ],
          };
        }
        return {
          kind: 'completed',
          state,
          output: state.transcript.join(','),
        };
      },
      applyToolResults: (state, executions) => ({
        ...state,
        transcript: [
          ...state.transcript,
          ...executions.map((execution) => execution.result.output),
        ],
      }),
    },
    tools: {
      execute: async (call, context): Promise<RuntimePipelineToolExecution<ToolCall, ToolResult>> => {
        order.push(`${context.turn}:${context.index}:${call.name}`);
        return { call, result: { output: `${call.name}-result` } };
      },
    },
  });

  const result = await pipeline.run({ sessionId: 'session-1', input: 'start' });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'start,one-result,two-result');
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(order, ['0:0:one', '0:1:two']);
});

test('stops after all calls in a turn when a tool returns a terminal control signal', async () => {
  let stopped = false;
  let applied = 0;
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult>({
    model: {
      initialize: () => ({ phase: 0, transcript: [] }),
      runTurn: async (state) => ({
        kind: 'tool_calls',
        state,
        calls: [
          { toolCallId: 'tool-1', name: 'first' },
          { toolCallId: 'tool-2', name: 'request_user_input' },
        ],
      }),
      applyToolResults: (state, executions) => {
        applied = executions.length;
        return state;
      },
      onStopped: () => {
        stopped = true;
      },
    },
    tools: {
      execute: async (call) => ({
        call,
        result: { output: call.name },
        terminal: call.name === 'request_user_input',
        terminalReason: call.name === 'request_user_input' ? 'waiting_user' : undefined,
      }),
    },
  });

  const result = await pipeline.run({ sessionId: 'session-1', input: 'start' });

  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'waiting_user');
  assert.equal(result.toolCalls, 2);
  assert.equal(applied, 2);
  assert.equal(stopped, true);
});

test('returns cancelled when aborted between model and tool execution', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult>({
    model: {
      initialize: () => ({ phase: 0, transcript: [] }),
      runTurn: async (state) => {
        controller.abort();
        return {
          kind: 'tool_calls',
          state,
          calls: [{ toolCallId: 'tool-1', name: 'never' }],
        };
      },
      applyToolResults: (state) => state,
      onCancelled: () => {
        cancelled = true;
      },
    },
    tools: {
      execute: async () => {
        throw new Error('tool executor should not run after abort');
      },
    },
  });

  const result = await pipeline.run(
    { sessionId: 'session-1', input: 'start' },
    { signal: controller.signal },
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'aborted');
  assert.equal(result.toolCalls, 0);
  assert.equal(cancelled, true);
});

test('emits runtime.error and returns failed status with preserved state', async () => {
  const events: RuntimeSdkEvent[] = [];
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult>({
    events: createEventSink(events),
    model: {
      initialize: () => ({ phase: 0, transcript: ['seed'] }),
      runTurn: async () => {
        throw new Error('provider failed');
      },
      applyToolResults: (state) => state,
    },
    tools: {
      execute: async (call) => ({ call, result: { output: '' } }),
    },
  });

  const result = await pipeline.run({ sessionId: 'session-1', input: 'start' });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'provider failed');
  assert.deepEqual(result.state, { phase: 0, transcript: ['seed'] });
  assert.deepEqual(events.map((event) => event.type), [
    'session.started',
    'runtime.error',
  ]);
  const errorEvent = events.at(-1);
  assert.equal(errorEvent?.type, 'runtime.error');
  if (errorEvent?.type === 'runtime.error') {
    assert.equal(errorEvent.message, 'provider failed');
  }
});

test('keeps Hook, permission, provider and Evidence inside the governed tool runtime', async () => {
  const events: RuntimeSdkEvent[] = [];
  const order: string[] = [];
  const eventRuntime = createRuntimeSdk({
    now: () => '2026-07-10T00:00:00.000Z',
    host: {
      hookRunner: {
        runPreToolUse: () => {
          order.push('pre-hook');
          return [{ hookId: 'pre-ask', decision: 'ask' }];
        },
        runPostToolUse: () => {
          order.push('post-hook');
          return [{ hookId: 'post-audit', decision: 'allow' }];
        },
      },
      approvalPort: {
        requestApproval: () => {
          order.push('permission');
          return { decision: 'allow' };
        },
      },
      executeProvider: async (request) => {
        order.push('provider');
        return {
          result: {
            toolCallId: request.call.toolCallId,
            status: 'completed',
            evidence: { evidenceId: 'evidence-1' },
          },
        };
      },
      createBlockedExecution: ({ request, reason }) => ({
        result: {
          toolCallId: request.call.toolCallId,
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
    },
  });
  eventRuntime.subscribe((event) => events.push(event));

  type GovernedState = { readonly phase: number; readonly evidence?: unknown };
  type GovernedResult = { readonly execution: Awaited<ReturnType<typeof eventRuntime.execute>> };
  const pipeline = createRuntimePipeline<null, GovernedState, ToolCall, GovernedResult, unknown>({
    events: eventRuntime,
    model: {
      initialize: () => ({ phase: 0 }),
      runTurn: (state) => state.phase === 0
        ? {
            kind: 'tool_calls',
            state: { ...state, phase: 1 },
            calls: [{
              toolCallId: 'tool-1',
              capabilityId: 'local.test',
              name: 'local.test',
              arguments: { value: 1 },
            }],
          }
        : { kind: 'completed', state },
      applyToolResults: (state, executions) => ({
        ...state,
        evidence: executions[0]?.result.execution.result.evidence,
      }),
    },
    tools: {
      execute: async (call) => ({
        call,
        result: {
          execution: await eventRuntime.execute({
            sessionId: 'session-1',
            conversationId: 'conversation-1',
            call: {
              toolCallId: call.toolCallId,
              capabilityId: call.capabilityId || call.name,
              arguments: call.arguments,
            },
          }),
        },
      }),
    },
  });

  const result = await pipeline.run({
    sessionId: 'session-1',
    streamId: 'stream-1',
    conversationId: 'conversation-1',
    input: null,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['pre-hook', 'permission', 'provider', 'post-hook']);
  assert.deepEqual(events.map((event) => event.type), [
    'session.started',
    'tool.started',
    'hook.completed',
    'permission.requested',
    'permission.resolved',
    'hook.completed',
    'tool.completed',
    'message.completed',
  ]);
  assert.equal(
    (result.state?.evidence as { hookFinalDecision?: string }).hookFinalDecision,
    'ask',
  );
  assert.equal(
    (result.state?.evidence as { hooks?: unknown[] }).hooks?.length,
    2,
  );
});

test('bounds runaway adapters and reports exhaustion', async () => {
  const events: RuntimeSdkEvent[] = [];
  let exhausted = false;
  const pipeline = createRuntimePipeline<string, State, ToolCall, ToolResult>({
    defaultMaxTurns: 2,
    events: createEventSink(events),
    model: {
      initialize: () => ({ phase: 0, transcript: [] }),
      runTurn: async (state) => ({ kind: 'continue', state }),
      applyToolResults: (state) => state,
      onExhausted: () => {
        exhausted = true;
      },
    },
    tools: {
      execute: async (call) => ({ call, result: { output: '' } }),
    },
  });

  const result = await pipeline.run({ sessionId: 'session-1', input: 'start' });

  assert.equal(result.status, 'exhausted');
  assert.equal(result.turns, 2);
  assert.equal(exhausted, true);
  assert.deepEqual(events.map((event) => event.type), [
    'session.started',
    'runtime.error',
  ]);
});
