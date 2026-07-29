import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __test__,
  isOpenAIResponsesTransientFailure,
  sendOpenAIResponsesStreamWithResilience,
} from './openai-responses-adapter.mjs';

const { consumeResponsesStream } = __test__;

function createHangAfterCompletedBody(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  let index = 0;
  let cancelled = false;
  let pending = null;

  return {
    get cancelled() {
      return cancelled;
    },
    getReader() {
      return {
        async read() {
          if (cancelled) return { done: true, value: undefined };
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          // 模拟 Grok/代理在 response.completed 后不关 TCP：永远不 done。
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        async cancel() {
          cancelled = true;
          if (pending) {
            pending({ done: true, value: undefined });
            pending = null;
          }
        },
      };
    },
  };
}

function createWebContents() {
  const events = [];
  return {
    events,
    send(channel, payload) {
      events.push({ channel, payload });
    },
  };
}

test('consumeResponsesStream ends on response.completed even if TCP stays open', async () => {
  const webContents = createWebContents();
  const body = createHangAfterCompletedBody([
    { type: 'response.output_text.delta', delta: 'hello' },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ]);

  const started = Date.now();
  const result = await Promise.race([
    consumeResponsesStream(
      { body },
      webContents,
      'stream-1',
      null,
      null,
      { streamIdleTimeoutMs: 5_000 },
    ),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('consumeResponsesStream hung after completed')), 500);
    }),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(result.content, 'hello');
  assert.equal(result.streamError, null);
  assert.deepEqual(result.streamUsage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(body.cancelled, true);
  assert.ok(elapsed < 500, `expected early exit, took ${elapsed}ms`);
  assert.ok(
    webContents.events.some((event) => event.channel === 'chat:stream:delta' && event.payload.content === 'hello'),
  );
  assert.ok(webContents.events.some((event) => event.channel === 'chat:stream:usage'));
});

test('consumeResponsesStream idle-timeouts when no terminal event arrives', async () => {
  const webContents = createWebContents();
  const body = createHangAfterCompletedBody([
    { type: 'response.output_text.delta', delta: 'partial' },
  ]);

  const result = await consumeResponsesStream(
    { body },
    webContents,
    'stream-2',
    null,
    null,
    { streamIdleTimeoutMs: 30 },
  );

  assert.equal(result.content, 'partial');
  assert.equal(result.streamError?.type, 'provider_stream_idle_timeout');
  assert.equal(body.cancelled, true);
});

test('isOpenAIResponsesTransientFailure classifies ChatGPT server_error as retryable', () => {
  assert.equal(
    isOpenAIResponsesTransientFailure({
      ok: false,
      providerError: true,
      errorText:
        'provider_stream_error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.',
      streamError: {
        type: 'server_error',
        message:
          'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.',
      },
    }),
    true,
  );

  assert.equal(
    isOpenAIResponsesTransientFailure({
      ok: false,
      providerError: true,
      errorText: 'provider_stream_error: Our servers are currently overloaded. Please try again later.',
      streamError: {
        type: 'server_is_overloaded',
        message: 'Our servers are currently overloaded. Please try again later.',
      },
    }),
    true,
  );

  assert.equal(
    isOpenAIResponsesTransientFailure({
      ok: false,
      status: 503,
      errorText: 'service unavailable',
    }),
    true,
  );

  // Partial output already streamed: do not silent-retry (unsafe replay).
  assert.equal(
    isOpenAIResponsesTransientFailure({
      ok: false,
      content: 'partial answer',
      streamError: { type: 'server_error', message: 'boom' },
      errorText: 'provider_stream_error: boom',
    }),
    false,
  );

  // Auth / permanent failure should not retry.
  assert.equal(
    isOpenAIResponsesTransientFailure({
      ok: false,
      status: 401,
      errorText: 'unauthorized',
    }),
    false,
  );
});

test('sendOpenAIResponsesStreamWithResilience retries server_error then succeeds', async () => {
  let calls = 0;
  const waits = [];
  const result = await sendOpenAIResponsesStreamWithResilience(
    async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          providerError: true,
          errorText:
            'provider_stream_error: An error occurred while processing your request. You can retry your request',
          streamError: {
            type: 'server_error',
            message: 'An error occurred while processing your request. You can retry your request',
          },
        };
      }
      return { ok: true, content: 'recovered', toolCalls: [] };
    },
    {
      transientRetryDelaysMs: [1, 1, 1],
      waitImpl: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.content, 'recovered');
  assert.equal(calls, 3); // initial + 2 retries
  assert.deepEqual(waits, [1, 1]);
});

test('sendOpenAIResponsesStreamWithResilience retries server_is_overloaded then succeeds', async () => {
  let calls = 0;
  const waits = [];
  const result = await sendOpenAIResponsesStreamWithResilience(
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          providerError: true,
          errorText: 'provider_stream_error: Our servers are currently overloaded. Please try again later.',
          streamError: {
            type: 'server_is_overloaded',
            message: 'Our servers are currently overloaded. Please try again later.',
          },
        };
      }
      return { ok: true, content: 'recovered after overload', toolCalls: [] };
    },
    {
      transientRetryDelaysMs: [1, 1, 1],
      waitImpl: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.content, 'recovered after overload');
  assert.equal(calls, 2); // initial + 1 retry
  assert.deepEqual(waits, [1]);
});

test('sendOpenAIResponsesStreamWithResilience surfaces error after 3 failed retries', async () => {
  let calls = 0;
  const waits = [];
  const failure = {
    ok: false,
    providerError: true,
    errorText:
      'provider_stream_error: An error occurred while processing your request. You can retry your request',
    streamError: {
      type: 'server_error',
      message: 'An error occurred while processing your request. You can retry your request',
    },
  };

  const result = await sendOpenAIResponsesStreamWithResilience(
    async () => {
      calls += 1;
      return failure;
    },
    {
      transientRetryDelaysMs: [1, 1, 1],
      waitImpl: async (ms) => {
        waits.push(ms);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.errorText, /provider_stream_error/);
  assert.equal(result.streamError?.type, 'server_error');
  assert.equal(calls, 4); // 1 initial + 3 retries
  assert.deepEqual(waits, [1, 1, 1]);
});
