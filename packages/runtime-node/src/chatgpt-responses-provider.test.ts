import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatGptResponsesProvider } from './chatgpt-responses-provider.ts';

const encoder = new TextEncoder();
function response(lines: readonly string[]): Response {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`${lines.join('\n')}\n`)); controller.close(); } }), { status: 200 });
}

test('ChatGPT Responses provider encodes requests, streams text, tools, and usage', async () => {
  const events: string[] = [];
  let captured: { url?: string; headers?: Headers; body?: any } = {};
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex/',
    tokens: { access: 'secret-access', accountId: 'account-1' },
    fetch: async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return response([
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"local_file_read","arguments":"{\\"path\\":\\"README.md\\"}"}}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}',
        'data: [DONE]',
      ]);
    },
  });
  const result = await provider.stream({
    model: 'gpt-test',
    messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hi' }],
    tools: [{ name: 'local_file_read', parameters: { type: 'object' } }],
    reasoningEffort: 'xhigh',
    onEvent: (event) => events.push(event.type),
  });
  assert.equal(captured.url, 'https://chatgpt.example/codex/responses');
  assert.equal(captured.headers?.get('authorization'), 'Bearer secret-access');
  assert.equal(captured.headers?.get('chatgpt-account-id'), 'account-1');
  assert.equal(captured.body.instructions, 'Be concise.');
  assert.equal(captured.body.model, 'gpt-test');
  assert.deepEqual(captured.body.reasoning, { effort: 'xhigh' });
  assert.equal(result.content, 'Hello');
  assert.deepEqual(result.toolCalls[0], { id: 'call-1', name: 'local_file_read', arguments: '{"path":"README.md"}' });
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  assert.deepEqual(events, ['text.delta', 'tool_call.completed', 'usage']);
});

test('ChatGPT Responses provider resolves desktop credentials lazily on first request', async () => {
  let resolutions = 0;
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex',
    resolveTokens: () => { resolutions += 1; return { access: 'lazy-access' }; },
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer lazy-access');
      return response(['data: [DONE]']);
    },
  });
  assert.equal(resolutions, 0);
  await provider.stream({ model: 'gpt-test', messages: [], tools: [] });
  assert.equal(resolutions, 1);
});

test('ChatGPT Responses provider refreshes and persists expiring OAuth tokens', async () => {
  let persisted = '';
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex',
    tokens: { access: 'old', refresh: 'refresh', expires: 1 },
    refreshTokens: async () => ({ access: 'new', refresh: 'refresh', expires: Date.now() + 60_000 }),
    persistTokens: (tokens) => { persisted = tokens.access; },
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new');
      return response(['data: [DONE]']);
    },
  });
  await provider.stream({ model: 'gpt-test', messages: [], tools: [] });
  assert.equal(persisted, 'new');
});

test('ChatGPT Responses provider forwards Grok channel identity headers', async () => {
  let captured: Headers | undefined;
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    tokens: { access: 'grok-access' },
    extraHeaders: {
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-surface': 'grok-build',
      'x-grok-client-version': '0.1.202',
    },
    fetch: async (_input, init) => {
      captured = new Headers(init?.headers);
      return response(['data: [DONE]']);
    },
  });
  await provider.stream({ model: 'grok-4.5', messages: [], tools: [] });
  assert.equal(captured?.get('authorization'), 'Bearer grok-access');
  assert.equal(captured?.get('x-xai-token-auth'), 'xai-grok-cli');
  assert.equal(captured?.get('x-grok-client-surface'), 'grok-build');
  assert.equal(captured?.get('x-grok-client-version'), '0.1.202');
  assert.equal(captured?.get('openai-beta'), 'responses=experimental');
});
