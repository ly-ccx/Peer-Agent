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
  assert.equal(captured.body.service_tier, undefined);
  assert.equal(result.content, 'Hello');
  assert.deepEqual(result.toolCalls[0], { id: 'call-1', name: 'local_file_read', arguments: '{"path":"README.md"}' });
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  assert.deepEqual(events, ['text.delta', 'tool_call.completed', 'usage']);
});

test('adds the priority service tier only when Fast mode is enabled', async () => {
  async function captureBody(input: { readonly model: string; readonly fastMode?: boolean }) {
    let body: Record<string, unknown> | undefined;
    const provider = createChatGptResponsesProvider({
      baseUrl: 'https://chatgpt.example/codex/',
      tokens: { access: 'secret-access', accountId: 'account-1' },
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return response([
          'data: {"type":"response.completed","response":{}}',
          'data: [DONE]',
        ]);
      },
    });
    await provider.stream({
      model: input.model,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      ...(input.fastMode ? { fastMode: true } : {}),
    });
    return body ?? {};
  }

  const standard = await captureBody({ model: 'gpt-5.5' });
  const fast = await captureBody({ model: 'gpt-5.5', fastMode: true });
  const grokFast = await captureBody({ model: 'grok-4.5', fastMode: true });

  assert.equal(standard.service_tier, undefined);
  assert.equal(fast.service_tier, 'priority');
  assert.equal(grokFast.service_tier, 'priority');
});

test('ChatGPT Responses provider reports prompt cache hit tokens in usage', async () => {
  let captured: { body?: any } = {};
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex/',
    tokens: { access: 'secret-access', accountId: 'account-1' },
    fetch: async (input, init) => {
      captured = { body: JSON.parse(String(init?.body)) };
      return response([
        'data: {"type":"response.output_text.delta","delta":"Cached"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":2,"input_tokens_details":{"cached_tokens":60}}}}',
        'data: [DONE]',
      ]);
    },
  });
  const result = await provider.stream({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'Hi' }],
    onEvent: () => {},
  });
  // 缓存命中 60/100：inputTokens 互斥扣减（净 40），cacheReadTokens 单独记账，totalTokens 保持上游毛口径。
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 2, totalTokens: 102, cacheReadTokens: 60 });
});

test('ChatGPT Responses provider reads cached_tokens from prompt_tokens_details when input_tokens_details is empty', async () => {
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex/',
    tokens: { access: 'secret-access', accountId: 'account-1' },
    fetch: async () => response([
      'data: {"type":"response.output_text.delta","delta":"Cached"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":2,"input_tokens_details":{},"prompt_tokens_details":{"cached_tokens":60}}}}',
      'data: [DONE]',
    ]),
  });
  const result = await provider.stream({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'Hi' }],
    onEvent: () => {},
  });
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 2, totalTokens: 102, cacheReadTokens: 60 });
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

test('ChatGPT Responses provider normalizes dotted historical tool names for wire encoding', async () => {
  let body: any;
  const provider = createChatGptResponsesProvider({
    baseUrl: 'https://chatgpt.example/codex',
    tokens: { access: 'access' },
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return response(['data: [DONE]']);
    },
  });

  await provider.stream({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_hist_1',
            name: 'local.file.read',
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_hist_1',
        content: 'ok',
      },
    ],
    tools: [
      {
        name: 'local.file.read',
        description: 'Read a local file',
        parameters: { type: 'object' },
      },
    ],
  });

  const functionCall = body.input.find((item: any) => item?.type === 'function_call');
  assert.equal(functionCall?.name, 'local_file_read');
  assert.equal(functionCall?.call_id, 'call_hist_1');
  assert.match(functionCall?.name ?? '', /^[a-zA-Z0-9_-]+$/);

  const toolDef = body.tools.find((tool: any) => tool?.type === 'function');
  assert.equal(toolDef?.name, 'local_file_read');
  assert.match(toolDef?.name ?? '', /^[a-zA-Z0-9_-]+$/);

  const toolOutput = body.input.find((item: any) => item?.type === 'function_call_output');
  assert.equal(toolOutput?.call_id, 'call_hist_1');
});
