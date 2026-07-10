import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDesktopPipelineEventAdapter,
  runDesktopRuntimePipeline,
} from './runtime-pipeline-adapter.mjs';

describe('Desktop Runtime Pipeline adapter', () => {
  it('forwards one session event while leaving Desktop terminal events authoritative', () => {
    const events = [];
    const state = { sessionStarted: false };
    const adapter = createDesktopPipelineEventAdapter({
      emitRuntimeEvent: (event) => {
        events.push(event);
        return event;
      },
      state,
    });

    adapter.emit({ type: 'session.started', sessionId: 'session-1' });
    adapter.emit({ type: 'session.started', sessionId: 'session-1' });
    adapter.emit({
      type: 'message.delta',
      sessionId: 'session-1',
      streamId: 'stream-1',
      content: 'hello',
    });
    adapter.emit({
      type: 'message.completed',
      sessionId: 'session-1',
      streamId: 'stream-1',
    });
    adapter.emit({
      type: 'runtime.error',
      sessionId: 'session-1',
      code: 'ignored',
      message: 'ignored',
    });

    assert.deepEqual(events.map((event) => event.type), [
      'session.started',
      'message.delta',
    ]);
    assert.equal(state.sessionStarted, true);
  });

  it('injects model and tool adapters into the public pipeline', async () => {
    const calls = [];
    const result = await runDesktopRuntimePipeline({
      sessionId: 'session-1',
      streamId: 'stream-1',
      maxTurns: 3,
      model: {
        initialize: () => ({ phase: 0, outputs: [] }),
        runTurn: (state) => state.phase === 0
          ? {
              kind: 'tool_calls',
              state: { ...state, phase: 1 },
              calls: [{ toolCallId: 'tool-1', name: 'local.test' }],
            }
          : { kind: 'completed', state, output: state.outputs[0] },
        applyToolResults: (state, executions) => ({
          ...state,
          outputs: executions.map((execution) => execution.result.output),
        }),
      },
      tools: {
        execute: async (call) => {
          calls.push(call.name);
          return { call, result: { output: 'tool-result' } };
        },
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'tool-result');
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(calls, ['local.test']);
  });

  it('converts structured pipeline cancellation back to Desktop AbortError semantics', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      runDesktopRuntimePipeline({
        sessionId: 'session-1',
        streamId: 'stream-1',
        signal: controller.signal,
        model: {
          initialize: () => ({ phase: 0 }),
          runTurn: (state) => ({ kind: 'completed', state }),
          applyToolResults: (state) => state,
        },
        tools: {
          execute: async (call) => ({ call, result: {} }),
        },
      }),
      (error) => error?.name === 'AbortError',
    );
  });
});
