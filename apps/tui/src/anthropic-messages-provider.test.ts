import { describe, expect, test } from 'bun:test';

import {
  createAnthropicMessagesProvider,
  type AnthropicMessagesStreamResult,
} from './anthropic-messages-provider.ts';

describe('createAnthropicMessagesProvider', () => {
  test('calls Desktop-style sendStream with Anthropic tools and split system', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = createAnthropicMessagesProvider({
      providerId: 'anthropic-cred',
      baseUrl: 'https://api.anthropic.com',
      getApiKey: async () => 'sk-ant-test',
      sendStream: async (args) => {
        calls.push(args);
        return {
          ok: true,
          textContent: 'hello from anthropic',
          thinkingContent: 'think',
          toolUseBlocks: [],
          stopReason: 'end_turn',
          streamUsage: { inputTokens: 4, outputTokens: 6 },
        } satisfies AnthropicMessagesStreamResult;
      },
    });

    const events: Array<{ type: string; content?: string }> = [];
    const result = await provider.stream({
      model: 'claude-sonnet-4-20250514',
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
    expect(args.apiKey).toBe('sk-ant-test');
    expect(args.model).toBe('claude-sonnet-4-20250514');
    expect(args.baseUrl).toBe('https://api.anthropic.com');
    expect(args.system).toBe('sys');
    expect(args.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(args.tools).toEqual([
      {
        name: 'bash',
        description: 'run shell',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
    expect(args.effort).toBe('high');
    expect(args.supportsReasoning).toBe(true);
    expect(args.webContents).toBeTruthy();
    // Must not look like OpenAI-compatible chat/completions path.
    expect(JSON.stringify(args)).not.toContain('/chat/completions');
    expect(JSON.stringify(args.tools)).toContain('input_schema');
    expect(JSON.stringify(args.tools)).not.toContain('"type":"function"');

    expect(result.content).toBe('hello from anthropic');
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
    expect(result.toolCalls).toEqual([]);
  });

  test('maps tool_use blocks into ModelToolCall arguments JSON', async () => {
    const provider = createAnthropicMessagesProvider({
      providerId: 'anthropic-cred',
      getApiKey: async () => 'sk-ant-test',
      sendStream: async () => ({
        ok: true,
        textContent: '',
        toolUseBlocks: [
          {
            id: 'toolu_1',
            name: 'bash',
            inputJson: '{"command":"pwd"}',
          },
        ],
        stopReason: 'tool_use',
      }),
    });

    const result = await provider.stream({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'run pwd' }],
    });

    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'bash', arguments: '{"command":"pwd"}' },
    ]);
  });

  test('does not use createOpenAICompatibleProvider path for anthropic failures', async () => {
    const provider = createAnthropicMessagesProvider({
      providerId: 'anthropic-cred',
      getApiKey: async () => 'sk-ant-test',
      sendStream: async () => ({
        ok: false,
        status: 401,
        errorText: 'invalid x-api-key',
      }),
    });

    await expect(
      provider.stream({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/401|invalid x-api-key|anthropic-cred/i);
  });
});
