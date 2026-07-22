import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from './openai-responses-adapter.mjs';

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
