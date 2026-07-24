import { describe, expect, test } from 'bun:test';
import {
  COMPACTION_SUMMARY_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT,
  type RuntimeToolDefinition,
} from '@peer-agent/runtime-core';
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
import { estimateTextTokens, estimateTokensFromMessages } from './context-pressure.ts';
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
    getAccessLevel: () => 'ask_before_local',
    setAccessLevel: () => 'ask_before_local',
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
    let contextWindow = 128_000;
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
        getContextWindow: () => contextWindow,
      }),
    });

    await controller.send('first');
    modelId = 'model-b';
    effort = 'high';
    contextWindow = 500_000;
    await controller.send('second');

    expect(requests[0]?.model).toBe('model-a');
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[1]?.model).toBe('model-b');
    expect(requests[1]?.reasoningEffort).toBe('high');
    const finalSnapshot = controller.getSnapshot();
    expect(finalSnapshot.requestProjection?.model).toBe('model-b');
    expect(finalSnapshot.requestProjection?.contextWindow).toBe(500_000);
    const sentRequestTokens = Math.ceil(
      estimateTokensFromMessages(requests[1]!.messages)
      + estimateTextTokens(JSON.stringify(requests[1]!.tools ?? [])),
    );
    expect(finalSnapshot.requestProjection?.nextRequestInputTokens).toBeGreaterThan(sentRequestTokens);
  });

  test('routes each turn through the provider selected at turn start', async () => {
    const calls: string[] = [];
    let selectedProvider = 'provider-a';
    const provider = (id: string): ModelProvider => ({
      async stream() {
        calls.push(id);
        return completed(id);
      },
    });
    const providers = new Map([
      ['provider-a', provider('provider-a')],
      ['provider-b', provider('provider-b')],
    ]);
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider: providers.get('provider-a')!,
        model: 'model-test',
        getProvider: () => providers.get(selectedProvider)!,
      }),
    });

    await controller.send('first');
    selectedProvider = 'provider-b';
    await controller.send('second');

    expect(calls).toEqual(['provider-a', 'provider-b']);
  });

  test('does not fall back to the previous provider when selected provider resolution fails', async () => {
    let fallbackCalls = 0;
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider: { async stream() { fallbackCalls += 1; return completed('fallback'); } },
        model: 'model-test',
        getProvider: () => { throw new Error('Selected provider is no longer available.'); },
      }),
    });

    await controller.send('hello');

    expect(fallbackCalls).toBe(0);
    expect(controller.getSnapshot().error).toContain('Selected provider is no longer available');
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

  test('recovers invalid JSON tool arguments without crashing the turn', async () => {
    const requests: ModelProviderRequest[] = [];
    const executions: Array<{ capabilityId: string; arguments_: Record<string, unknown> }> = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call-bad-json',
              name: 'local_file_list',
              arguments: '{"path":"/tmp"',
            }],
          };
        }
        request.onEvent?.({ type: 'text.delta', content: 'recovered from bad args' });
        return completed('recovered from bad args');
      },
    };
    const controller = createChatController({
      host: host((capabilityId, arguments_) => {
        executions.push({ capabilityId, arguments_ });
        return execution('invalid args wrapped');
      }),
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [{
          capabilityId: 'local.file.list',
          name: 'local_file_list',
          description: 'List files',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        }],
      }),
    });

    await controller.send('list files');

    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().status).toBe('idle');
    expect(executions).toEqual([{
      capabilityId: 'local.file.list',
      arguments_: { raw_arguments: '{"path":"/tmp"' },
    }]);
    expect(requests).toHaveLength(2);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('recovered from bad args');
  });

  test('recovers non-object tool arguments without crashing the turn', async () => {
    const requests: ModelProviderRequest[] = [];
    const executions: Array<{ capabilityId: string; arguments_: Record<string, unknown> }> = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call-array-args',
              name: 'local_file_list',
              arguments: '["/tmp"]',
            }],
          };
        }
        request.onEvent?.({ type: 'text.delta', content: 'recovered from array args' });
        return completed('recovered from array args');
      },
    };
    const controller = createChatController({
      host: host((capabilityId, arguments_) => {
        executions.push({ capabilityId, arguments_ });
        return execution('non-object args wrapped');
      }),
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [{
          capabilityId: 'local.file.list',
          name: 'local_file_list',
          description: 'List files',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        }],
      }),
    });

    await controller.send('list files as array');

    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().status).toBe('idle');
    expect(executions).toEqual([{
      capabilityId: 'local.file.list',
      arguments_: { raw_arguments: '["/tmp"]' },
    }]);
    expect(requests).toHaveLength(2);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('recovered from array args');
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

  test('injects a Goal-mode system prompt that requires creating a draft plan first', async () => {
    const requests: ModelProviderRequest[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        return completed('ok');
      },
    };
    const controller = createChatController({
      host: host(),
      initialMode: 'goal',
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [],
      }),
    });

    await controller.send('build a feature');

    const system = requests[0]?.messages.find((message) => message.role === 'system');
    const content = typeof system?.content === 'string'
      ? system.content
      : JSON.stringify(system?.content ?? '');
    expect(content).toContain('You are in Goal mode');
    expect(content).toContain('goal_create_plan');
    expect(content).toContain('side-effecting');
  });

  test('uses the active provider and shared prompts for compaction without exposing tools', async () => {
    const requests: ModelProviderRequest[] = [];
    const progress: number[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        request.onEvent?.({ type: 'text.delta', content: 'semantic summary' });
        return completed('semantic summary');
      },
    };
    const model = createProviderChatModel({
      provider,
      model: 'model-test',
      toolDefinitions,
    });

    const summary = await model.summarizeCompaction?.({
      messages: [{ role: 'user', content: 'old turn' }],
      formattedHistory: '[user]: old turn',
      onProgress: (percent) => progress.push(percent),
    });

    expect(summary).toBe('semantic summary');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe('model-test');
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.temperature).toBe(0.2);
    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: '[user]: old turn' },
      { role: 'user', content: COMPACTION_SUMMARY_PROMPT },
    ]);
    expect(progress.at(-1)).toBe(100);
  });

  test('injects a Plan-mode system prompt for plan turns', async () => {
    const requests: ModelProviderRequest[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(request);
        return completed('ok');
      },
    };
    const controller = createChatController({
      host: host(),
      initialMode: 'plan',
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [],
      }),
    });

    await controller.send('investigate');

    const system = requests[0]?.messages.find((message) => message.role === 'system');
    const content = typeof system?.content === 'string'
      ? system.content
      : JSON.stringify(system?.content ?? '');
    expect(content).toContain('You are in read-only Plan mode');
  });
});


describe('createProviderChatModel stream recovery', () => {
  test('retries recoverable stream failure before any deltas', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        attempts += 1;
        if (attempts === 1) {
          throw connectionError('The socket connection was closed unexpectedly.');
        }
        request.onEvent?.({ type: 'text.delta', content: 'ok after retry' });
        return completed('ok after retry');
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [],
      }),
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      waits.push(typeof _ms === 'number' ? _ms : 0);
      return realSetTimeout(fn, 0, ...args);
    }) as typeof setTimeout;

    try {
      await controller.send('hello');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(attempts).toBe(2);
    expect(waits.length).toBeGreaterThan(0);
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(controller.getSnapshot().messages.at(-1)?.content).toContain('ok after retry');
  });

  test('does not retry after partial deltas were emitted', async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      async stream(request) {
        attempts += 1;
        request.onEvent?.({ type: 'text.delta', content: 'partial ' });
        throw connectionError('The socket connection was closed unexpectedly.');
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [],
      }),
    });
    await controller.send('hello');
    expect(attempts).toBe(1);
    expect(controller.getSnapshot().error).toContain('socket connection was closed unexpectedly');
  });

  test('does not retry non-recoverable provider errors', async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      async stream() {
        attempts += 1;
        throw new Error('invalid api key');
      },
    };
    const controller = createChatController({
      host: host(),
      model: createProviderChatModel({
        provider,
        model: 'model-test',
        toolDefinitions: [],
      }),
    });
    await controller.send('hello');
    expect(attempts).toBe(1);
    expect(controller.getSnapshot().error).toContain('invalid api key');
  });
});

function connectionError(message: string): Error {
  return new TypeError(message);
}
