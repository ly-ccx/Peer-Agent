import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDesktopPipelineEventAdapter,
  runDesktopRuntimePipeline,
} from './runtime-pipeline-adapter.mjs';

describe('Desktop Runtime Pipeline adapter', () => {
  it('forwards paired tool executions and run context to the critical checkpoint', async () => {
    const call = { name: 'write_file', toolCallId: 'tool-write' };
    const execution = { call, result: { output: 'saved' } };
    let committed = false;
    const result = await runDesktopRuntimePipeline({ sessionId: 'checkpoint-session', streamId: 'checkpoint-stream',
      model: { initialize: () => ({ phase: 0 }), applyToolResults: state => ({ ...state, phase: 1 }),
        runTurn: state => state.phase === 0 ? { kind: 'tool_calls', state, calls: [call] } : { kind: 'completed', state },
        checkpoint(state, executions, context) {
          assert.equal(state.phase, 1);
          assert.deepEqual(executions, [execution]);
          assert.equal(context.run.streamId, 'checkpoint-stream');
          committed = true;
        },
      }, tools: { execute: async () => execution },
    });
    assert.equal(result.status, 'completed');
    assert.equal(committed, true);
  });

  it('preserves request failure facts and never debits another logical request', async () => {
    let debits = 0;
    const detail = { kind: 'response_headers_timeout', requestId: 'provider-request-fixture', retryable: true, attempts: 4 };
    await assert.rejects(runDesktopRuntimePipeline({ sessionId: 'fixture', streamId: 'fixture',
      budgetGuard: { beforeRequest() { debits++; } },
      model: { initialize: () => ({}), applyToolResults: state => state,
        runTurn() { throw Object.assign(new Error('connect timeout after 20000ms (ConnectTimeoutError)'), { providerRecovery: detail }); } },
      tools: { execute: async call => ({ call, result: {} }) },
    }), error => error.providerRecovery === detail);
    assert.equal(debits, 0);
  });

  it('critical checkpoint failure stops terminal tools and retains execution uncertainty', async () => {
    let rounds = 0;
    let published = false;
    await assert.rejects(runDesktopRuntimePipeline({ sessionId: 'fixture', streamId: 'fixture',
      lifecycle: { toolResultsApplied() { published = true; } },
      model: { initialize: () => ({}), applyToolResults: state => state,
        checkpoint() { throw new Error('fixture storage failed'); },
        runTurn(state) { rounds++; return { kind: 'tool_calls', state, calls: [{ name: 'read_file', toolCallId: 'tool' }] }; },
      },
      tools: { execute: async call => ({ call, result: { output: 'fixture' }, terminal: true, terminalReason: 'completed' }) },
    }), error => error.message === 'checkpoint_persistence_failed' && error.providerRecovery?.kind === 'execution_outcome_unknown');
    assert.equal(rounds, 1);
    assert.equal(published, false);
  });

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
    const lifecycleStates = [];
    const result = await runDesktopRuntimePipeline({
      sessionId: 'session-1',
      streamId: 'stream-1',
      maxTurns: 3,
      lifecycle: {
        toolResultsApplied: (state) => lifecycleStates.push([...state.outputs]),
      },
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
    assert.deepEqual(lifecycleStates, [['tool-result']]);
  });

  it('converts structured pipeline failure back to Desktop error semantics', async () => {
    await assert.rejects(
      runDesktopRuntimePipeline({
        sessionId: 'session-1',
        streamId: 'stream-1',
        model: {
          initialize: () => ({ phase: 0 }),
          runTurn: () => {
            throw new Error('persist failed for test');
          },
          applyToolResults: (state) => state,
        },
        tools: {
          execute: async (call) => ({ call, result: {} }),
        },
      }),
      /persist failed for test/,
    );
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
