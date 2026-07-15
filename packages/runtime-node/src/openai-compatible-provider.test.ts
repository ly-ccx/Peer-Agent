import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelStreamEvent } from './model-provider-contracts.ts';
import {
  createOpenAICompatibleProvider,
  ModelProviderHttpError,
  ModelProviderStreamError,
} from './openai-compatible-provider.ts';

const encoder = new TextEncoder();

function sseResponse(records: readonly string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const record of records) controller.enqueue(encoder.encode(`data: ${record}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function provider(fetchImplementation: typeof fetch) {
  return createOpenAICompatibleProvider({
    config: {
      providerId: 'openai',
      apiKey: 'secret-key',
      baseUrl: 'https://example.test/v1/',
      organizationId: 'org-1',
      headers: { 'X-Custom': 'yes' },
    },
    fetch: fetchImplementation,
  });
}

test('streams text and usage without exposing credentials in the result', async () => {
  const events: ModelStreamEvent[] = [];
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const model = provider(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      '[DONE]',
    ]);
  });

  const result = await model.stream({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'Hi' }],
    onEvent: (event) => events.push(event),
  });

  assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
  assert.equal(new Headers(capturedInit?.headers).get('Authorization'), 'Bearer secret-key');
  assert.equal(new Headers(capturedInit?.headers).get('OpenAI-Organization'), 'org-1');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(result, {
    content: 'Hello', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
  assert.deepEqual(events.map((event) => event.type), ['text.delta', 'text.delta', 'usage']);
  assert.doesNotMatch(JSON.stringify(result), /secret-key/);
});

test('encodes explicit reasoning effort without overriding provider defaults', async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = provider(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse(['[DONE]']);
  });

  await model.stream({ model: 'gpt-test', messages: [], reasoningEffort: 'high' });
  await model.stream({ model: 'gpt-test', messages: [], reasoningEffort: 'default' });

  assert.equal(bodies[0]?.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in (bodies[1] ?? {}), false);
});

test('assembles streamed tool calls and serializes tools', async () => {
  const events: ModelStreamEvent[] = [];
  let body: Record<string, unknown> = {};
  const model = provider(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"pa' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] } }] }),
      '[DONE]',
    ]);
  });

  const result = await model.stream({
    model: 'gpt-test', messages: [],
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }]);
  assert.equal(events.at(-1)?.type, 'tool_call.completed');
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }]);
});

test('passes AbortSignal to fetch and preserves cancellation', async () => {
  const controller = new AbortController();
  const model = provider(async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(new DOMException('Cancelled', 'AbortError'));
    });
  });
  await assert.rejects(model.stream({ model: 'gpt-test', messages: [], signal: controller.signal }), { name: 'AbortError' });
});

test('returns typed HTTP and malformed SSE errors without credentials', async () => {
  const httpModel = provider(async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }));
  await assert.rejects(httpModel.stream({ model: 'gpt-test', messages: [] }), (error: unknown) => {
    assert.ok(error instanceof ModelProviderHttpError);
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });

  const streamModel = provider(async () => sseResponse(['not-json']));
  await assert.rejects(streamModel.stream({ model: 'gpt-test', messages: [] }), ModelProviderStreamError);
});
