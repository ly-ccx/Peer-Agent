import { describe, expect, test } from 'bun:test';
import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type {
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
} from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import { createChatController } from './chat-controller.ts';
import {
  createProviderChatModel,
  createUnavailableChatModel,
} from './provider-chat-model.ts';
import type { TuiHost } from './tui-host.ts';

const toolDefinitions: RuntimeToolDefinition[] = [{
  name: 'read_file',
  capabilityId: 'local.file.read',
  description: 'Read a workspace file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

function execution(outputPreview: string): RuntimeSdkProviderExecution {
  return {
    result: {
      status: 'completed',
      outputPreview,
      output: { content: outputPreview },
      evidence: { source: 'test' },
    },
  };
}

function host(
  run: (capabilityId: string, arguments_: Record<string, unknown>) => RuntimeSdkProviderExecution =
    () => execution('file contents'),
): TuiHost {
  return {
    workspaceRoot: '/tmp/test',
    capabilities: ['local.file.read'],
    toolDefinitions,
    execute: async (capabilityId, arguments_) => run(capabilityId, arguments_),
    executeRead: async () => execution('file contents'),
    executeShell: async () => execution('shell'),
    subscribe: () => () => {},
    subscribeApproval(listener) {
      listener(null);
      return () => {};
    },
  };
}

function completed(content: string): ModelProviderResult {
  return { content, toolCalls: [] };
}

describe('OpenAI-compatible TUI chat adapter', () => {
  test('reads model and reasoning selection at turn start', async () => {
    const requests: ModelProviderRequest[] = [];
    let modelId = 'model-a';
    let effort: 'default' | 'high' = 'default';
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        return completed('done');
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider,
        model: modelId,
        getModel: () => modelId,
        getReasoningEffort: () => effort,
      }),
    });

    await controller.send('first');
    modelId = 'model-b';
    effort = 'high';
    await controller.send('second');

    expect(requests[0]?.model).toBe('model-a');
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[1]?.model).toBe('model-b');
    expect(requests[1]?.reasoningEffort).toBe('high');
  });

  test('exposes only the tool definitions projected for the active mode', async () => {
    const requests: ModelProviderRequest[] = [];
    const writeTool: RuntimeToolDefinition = {
      name: 'write_file',
      capabilityId: 'local.file.write',
      description: 'Write a workspace file',
    };
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        return completed('done');
      },
    };
    const model = createProviderChatModel({
      provider,
      model: 'model-test',
      toolDefinitionsForMode: (mode) => mode === 'goal'
        ? [...toolDefinitions, writeTool]
        : toolDefinitions,
    });
    const controller = createChatController({ host: host(), model, initialMode: 'explorer' });

    await controller.send('inspect');
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['read_file']);

    expect(controller.setMode('goal')).toBe(true);
    await controller.send('execute');
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['read_file', 'write_file']);
  });

  test('rejects a model tool call that is absent from the active mode projection', async () => {
    const provider: ModelProvider = {
      async stream() {
        return {
          content: '',
          toolCalls: [{ id: 'write-1', name: 'write_file', arguments: '{}' }],
        };
      },
    };
    const controller = createChatController({
      host: host(),
      initialMode: 'explorer',
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitionsForMode: () => toolDefinitions,
      }),
    });

    await controller.send('write anyway');

    expect(controller.getSnapshot().error).toContain('unavailable tool "write_file"');
  });

  test('streams text through the chat controller and exposes projected tools', async () => {
    const requests: ModelProviderRequest[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        request.onEvent?.({ type: 'text.delta', content: 'hello ' });
        request.onEvent?.({ type: 'text.delta', content: 'world' });
        return {
          ...completed('hello world'),
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        };
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({ provider, model: 'model-test', toolDefinitions }),
    });

    await controller.send('hi');

    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('hello world');
    expect(controller.getSnapshot().usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
    expect(requests[0]?.model).toBe('model-test');
    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
    expect(requests[0]?.tools).toEqual([{
      name: 'read_file',
      description: 'Read a workspace file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }]);
  });

  test('executes model tool calls through Runtime and resumes with assistant/tool history', async () => {
    const requests: ModelProviderRequest[] = [];
    const executions: Array<{ capabilityId: string; arguments_: Record<string, unknown> }> = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"note.txt"}' }],
          };
        }
        request.onEvent?.({ type: 'text.delta', content: 'read complete' });
        return completed('read complete');
      },
    };
    const controller = createChatController({
      host: host((capabilityId, arguments_) => {
        executions.push({ capabilityId, arguments_ });
        return execution('note contents');
      }),
      model: createProviderChatModel({ provider, model: 'model-test', toolDefinitions }),
    });

    await controller.send('read note');

    expect(executions).toEqual([{
      capabilityId: 'local.file.read',
      arguments_: { path: 'note.txt' },
    }]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'read note' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"note.txt"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: JSON.stringify({
          status: 'completed',
          output: { content: 'note contents' },
          outputPreview: 'note contents',
        }),
      },
    ]);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('read complete');
  });

  test('preserves completed model history across user turns', async () => {
    const requests: ModelProviderRequest[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        const answer = `answer-${requests.length}`;
        request.onEvent?.({ type: 'text.delta', content: answer });
        return completed(answer);
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({ provider, model: 'model-test', toolDefinitions: [] }),
    });

    await controller.send('first');
    await controller.send('second');

    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer-1' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('cancels the provider request through AbortSignal', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const provider: ModelProvider = {
      async stream(request) {
        started();
        return await new Promise<ModelProviderResult>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({ provider, model: 'model-test', toolDefinitions: [] }),
    });

    const running = controller.send('wait');
    await didStart;
    controller.cancel();
    await running;

    expect(controller.getSnapshot().status).toBe('idle');
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  test('keeps provider errors useful without leaking a credential into chat', async () => {
    const secret = 'super-secret-value';
    const provider: ModelProvider = {
      async stream() {
        throw new Error('Model request failed with HTTP 401.');
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({ provider, model: 'model-test', toolDefinitions: [] }),
    });

    await controller.send('hi');

    expect(controller.getSnapshot().error).toBe('Model request failed with HTTP 401.');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(secret);
  });

  test('shows an actionable message when no credential is configured', async () => {
    const controller = createChatController({
      host: host(),
      model: createUnavailableChatModel('Set PEER_MODEL_API_KEY to continue.'),
    });

    await controller.send('hi');

    expect(controller.getSnapshot().messages.at(-1)?.content).toContain('PEER_MODEL_API_KEY');
  });
});
