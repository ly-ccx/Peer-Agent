import { describe, expect, test } from 'bun:test';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import {
  createChatController,
  type ChatModelPort,
  type ChatModelState,
} from './chat-controller.ts';
import type { TuiHost } from './tui-host.ts';

function execution(outputPreview: string): RuntimeSdkProviderExecution {
  return {
    result: {
      status: 'completed',
      outputPreview,
      evidence: { source: 'test' },
    },
  } as RuntimeSdkProviderExecution;
}

function host(run: (capabilityId: string, arguments_: Record<string, unknown>) => RuntimeSdkProviderExecution =
  (capabilityId) => execution(capabilityId)): TuiHost {
  return {
    workspaceRoot: '/tmp/test',
    capabilities: ['local.file.read'],
    toolDefinitions: [{ name: 'read_file', capabilityId: 'local.file.read' }],
    execute: async (capabilityId, arguments_) => run(capabilityId, arguments_),
    executeRead: async () => execution('read'),
    executeShell: async () => execution('shell'),
    subscribe: () => () => {},
    subscribeApproval: (listener) => {
      listener(null);
      return () => {};
    },
  };
}

const initialState = (input: { content: string }): ChatModelState => ({
  messages: [{ id: 'input', role: 'user', content: input.content }],
  modelMessages: [{ role: 'user', content: input.content }],
  toolExecutions: [],
});

describe('chat controller', () => {
  test('streams assistant deltas into one message', async () => {
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        context.emit({ type: 'message.delta', streamId: 'test', content: 'hello ' });
        context.emit({ type: 'message.delta', streamId: 'test', content: 'world' });
        return { kind: 'completed', state, output: 'hello world' };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    await controller.send('hi');

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().messages.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello world'],
    ]);
  });

  test('executes model tool calls through the TUI host and resumes the model', async () => {
    const calls: string[] = [];
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      runTurn(state, context) {
        if (state.toolExecutions.length === 0) {
          return {
            kind: 'tool_calls',
            state,
            calls: [{
              toolCallId: 'call-1',
              capabilityId: 'local.file.read',
              arguments: { path: 'package.json' },
            }],
          };
        }
        context.emit({ type: 'message.delta', streamId: 'test', content: 'finished' });
        return { kind: 'completed', state, output: 'finished' };
      },
      applyToolResults(state, results) {
        return { ...state, toolExecutions: results.map((item) => item.result) };
      },
    };
    const controller = createChatController({
      model,
      host: host((capabilityId) => {
        calls.push(capabilityId);
        return execution('file contents');
      }),
    });

    await controller.send('read it');

    expect(calls).toEqual(['local.file.read']);
    expect(controller.getSnapshot().messages.some((message) => message.role === 'tool')).toBe(true);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('finished');
  });

  test('cancels an active model turn', async () => {
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => { started = resolve; });
    const model: ChatModelPort = {
      initialize: (input) => initialState(input.input),
      async runTurn(state, context) {
        started();
        await new Promise<void>((resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
        return { kind: 'completed', state };
      },
      applyToolResults: (state) => state,
    };
    const controller = createChatController({ host: host(), model });

    const running = controller.send('wait');
    await isStarted;
    controller.cancel();
    expect(controller.getSnapshot().status).toBe('cancelling');
    await running;

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().error).toBeUndefined();
  });
});
