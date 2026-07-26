import { describe, expect, test } from 'bun:test';

import {
  createGeminiProvider,
  type GeminiStreamResult,
} from './gemini-provider.ts';

describe('createGeminiProvider', () => {
  test('API-key count and send share the same canonical history, tools, and output limit', async () => {
    let counted: Record<string, unknown> | undefined;
    let sent: Record<string, unknown> | undefined;
    const provider = createGeminiProvider({
      providerId: 'gemini-cred',
      authMethod: 'api_key',
      getApiKey: async () => 'AIza-test',
      countInputTokens: async (args) => {
        counted = args;
        return { inputTokens: 501_244, source: 'provider_count_api' };
      },
      sendStream: async (args) => {
        sent = args;
        return {
          ok: true,
          content: 'done',
          toolCalls: [],
          streamUsage: { inputTokens: 501_244, outputTokens: 1 },
        };
      },
    });
    const request = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system' as const, content: 'shared system' },
        { role: 'user' as const, content: 'inspect' },
        {
          role: 'assistant' as const,
          content: null,
          toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
        },
        { role: 'tool' as const, toolCallId: 'tool-1', content: 'tool evidence' },
      ],
      tools: [{
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      reasoningEffort: 'high' as const,
      maxOutputTokens: 8_192,
    };

    expect(await provider.countInputTokens?.(request)).toEqual({
      inputTokens: 501_244,
      source: 'provider_count_api',
    });
    await provider.stream(request);

    for (const key of ['model', 'messages', 'tools', 'maxOutputTokens']) {
      expect(counted?.[key]).toEqual(sent?.[key]);
    }
  });

  test('calls Desktop-style sendGeminiStream without openai shim rewrite', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = createGeminiProvider({
      providerId: 'gemini-cred',
      authMethod: 'oauth_google',
      getApiKey: async () => 'ya29.test-token',
      getProjectId: async () => 'proj-123',
      sendStream: async (args) => {
        calls.push(args);
        return {
          ok: true,
          content: 'hello from gemini',
          thinkingContent: 'plan',
          toolCalls: [],
          streamUsage: { inputTokens: 3, outputTokens: 5 },
        } satisfies GeminiStreamResult;
      },
    });

    const events: Array<{ type: string; content?: string }> = [];
    const result = await provider.stream({
      model: 'models/gemini-2.5-pro',
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
    expect(args.apiKey).toBe('ya29.test-token');
    expect(args.model).toBe('models/gemini-2.5-pro');
    expect(args.authMethod).toBe('oauth_google');
    expect(args.projectId).toBe('proj-123');
    // Must use Code Assist host by default for OAuth — never .../v1beta/openai.
    expect(String(args.baseUrl)).toBe('https://cloudcode-pa.googleapis.com');
    expect(String(args.baseUrl)).not.toContain('/openai');
    expect(JSON.stringify(args)).not.toContain('/chat/completions');
    expect(JSON.stringify(args)).not.toContain('v1beta/openai');

    expect(result.content).toBe('hello from gemini');
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  test('maps function-style tool calls into ModelToolCall', async () => {
    const provider = createGeminiProvider({
      providerId: 'gemini-cred',
      authMethod: 'api_key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      getApiKey: async () => 'AIza-test',
      sendStream: async () => ({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            function: { name: 'bash', arguments: '{"command":"pwd"}' },
          },
        ],
      }),
    });

    const result = await provider.stream({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'run pwd' }],
    });

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' },
    ]);
  });

  test('surfaces HTTP failures instead of falling through to openai-compatible', async () => {
    const provider = createGeminiProvider({
      providerId: 'gemini-cred',
      authMethod: 'oauth_google',
      getApiKey: async () => 'ya29.bad',
      sendStream: async () => ({
        ok: false,
        status: 401,
        errorText: 'invalid oauth token',
      }),
    });

    await expect(
      provider.stream({
        model: 'models/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
