import { describe, expect, test } from 'bun:test';

import {
  createQoderPrivateProvider,
  type QoderPrivateStreamResult,
} from './qoder-private-provider.ts';

describe('createQoderPrivateProvider', () => {
  test('calls Desktop-style private sendStream with OpenAI-shaped messages/tools', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = createQoderPrivateProvider({
      providerId: 'qoder-cred',
      baseUrl: 'https://api2-v2.qoder.sh/model/v1',
      getAccessToken: async () => 'qoder-token',
      sendStream: async (args) => {
        calls.push(args);
        return {
          ok: true,
          content: 'hello from private',
          thinkingContent: 'think',
          toolCalls: [],
          streamUsage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        } satisfies QoderPrivateStreamResult;
      },
    });

    const events: Array<{ type: string; content?: string }> = [];
    const result = await provider.stream({
      model: 'gm51model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          name: 'bash',
          description: 'run shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      reasoningEffort: 'high',
      onEvent(event) {
        if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
          events.push({ type: event.type, content: event.content });
        }
      },
    });

    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args.apiKey).toBe('qoder-token');
    expect(args.model).toBe('gm51model');
    expect(args.baseUrl).toBe('https://api2-v2.qoder.sh/model/v1');
    expect(args.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(args.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'run shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ]);
    expect(args.modelOptionValues).toEqual({ reasoning: 'high' });
    expect(args.webContents).toBeTruthy();
    // Must not look like OpenAI-compatible chat/completions provider path.
    expect(JSON.stringify(args)).not.toContain('/chat/completions');

    expect(result.content).toBe('hello from private');
    expect(result.thinkingContent).toBe('think');
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
    expect(result.toolCalls).toEqual([]);
  });

  test('bridges desktop webContents deltas into ModelProvider onEvent', async () => {
    const provider = createQoderPrivateProvider({
      providerId: 'qoder-cred',
      getAccessToken: async () => 'tok',
      sendStream: async (args) => {
        const webContents = args.webContents as {
          send: (channel: string, payload: Record<string, unknown>) => void;
        };
        webContents.send('chat:stream:thinking', { content: 'step1' });
        webContents.send('chat:stream:delta', { content: 'partial ' });
        webContents.send('chat:stream:delta', { content: 'answer' });
        return {
          ok: true,
          content: 'partial answer',
          thinkingContent: 'step1',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }],
        };
      },
    });

    const events: Array<{ type: string; content?: string }> = [];
    const result = await provider.stream({
      model: 'auto',
      messages: [{ role: 'user', content: 'x' }],
      onEvent(event) {
        if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
          events.push({ type: event.type, content: event.content });
        }
      },
    });

    expect(events).toEqual([
      { type: 'reasoning.delta', content: 'step1' },
      { type: 'text.delta', content: 'partial ' },
      { type: 'text.delta', content: 'answer' },
    ]);
    expect(result.toolCalls).toEqual([
      { id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    ]);
  });

  test('does not use createOpenAICompatibleProvider path for qoder failures', async () => {
    const provider = createQoderPrivateProvider({
      providerId: 'qoder-cred',
      getAccessToken: async () => 'tok',
      sendStream: async () => ({
        ok: false,
        status: 402,
        errorText: 'payment required',
        providerError: true,
      }),
    });

    await expect(
      provider.stream({
        model: 'gm51model',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/402|payment required|qoder-cred/i);
  });
});
