import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelStreamEvent } from './model-provider-contracts.ts';
import {
  consumeOpenAIChatStream,
  ModelProviderStreamError,
} from './openai-chat-stream.ts';

const encoder = new TextEncoder();

function sseResponse(records: readonly (string | object)[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const record of records) {
        const payload = typeof record === 'string' ? record : JSON.stringify(record);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  }));
}

test('consumes standard OpenAI text, reasoning, fragmented tools, and cached usage', async () => {
  const events: ModelStreamEvent[] = [];
  const result = await consumeOpenAIChatStream({
    response: sseResponse([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { reasoning: [{ text: 'think' }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'fi', arguments: '{"path"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'le', arguments: ':"a"}' } }] } }] },
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      '[DONE]',
    ]),
    providerId: 'openai',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.content, 'hello');
  assert.equal(result.reasoningContent, 'think');
  assert.deepEqual(result.toolCalls, [{
    id: 'call-1',
    name: 'file',
    arguments: '{"path":"a"}',
  }]);
  assert.deepEqual(result.usage, {
    inputTokens: 7,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadTokens: 3,
  });
  assert.deepEqual(events.map((event) => event.type), [
    'text.delta',
    'reasoning.delta',
    'tool_call.delta',
    'tool_call.delta',
    'usage',
    'tool_call.completed',
  ]);
});

test('supports strict and tolerant malformed payload policies', async () => {
  await assert.rejects(
    consumeOpenAIChatStream({
      response: sseResponse(['not-json']),
      providerId: 'openai',
    }),
    ModelProviderStreamError,
  );

  const malformed: string[] = [];
  const result = await consumeOpenAIChatStream({
    response: sseResponse(['not-json', { choices: [{ delta: { content: 'ok' } }] }, '[DONE]']),
    providerId: 'openai',
    malformedPayload: 'ignore',
    onMalformedPayload: (payload) => malformed.push(payload),
  });
  assert.deepEqual(malformed, ['not-json']);
  assert.equal(result.content, 'ok');
});

test('can return structured SSE errors for host adapters or throw by default', async () => {
  const response = () => sseResponse([{ error: { type: 'rate_limit', message: 'slow down' } }]);
  await assert.rejects(
    consumeOpenAIChatStream({ response: response(), providerId: 'openai' }),
    /slow down/,
  );

  const result = await consumeOpenAIChatStream({
    response: response(),
    providerId: 'openai',
    streamErrorMode: 'return',
  });
  assert.deepEqual(result.streamError, { type: 'rate_limit', message: 'slow down' });
});

test('cancels the reader when the abort signal fires', async () => {
  const controller = new AbortController();
  let readerCancelled = false;
  const response = new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    },
    cancel() {
      readerCancelled = true;
    },
  }));

  const pending = consumeOpenAIChatStream({
    response,
    providerId: 'openai',
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort(new Error('cancelled')));
  await assert.rejects(pending, /cancelled/);
  assert.equal(readerCancelled, true);
});

test('fails stalled streams with an idle timeout', async () => {
  const response = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(
    consumeOpenAIChatStream({
      response,
      providerId: 'openai',
      idleTimeoutMs: 5,
    }),
    /provider_stream_idle_timeout/,
  );
});
