import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  normalizeQoderModel,
  qoderModelServerBaseUrl,
  sendQoderPrivateStream,
} from './qoder-private-adapter.mjs';
import { consumeOpenAIStream } from './openai-chat-adapter.mjs';

describe('qoder private adapter', () => {
  it('normalizes the auto model to Qoder model-server format', () => {
    assert.equal(normalizeQoderModel('Auto'), 'auto');
    assert.equal(normalizeQoderModel('auto'), 'auto');
    assert.equal(normalizeQoderModel('qoder-special'), 'qoder-special');
  });

  it('builds a model-server chat completion body with Qoder metadata', () => {
    const body = buildQoderPrivateRequestBody({
      model: 'Auto',
      requestId: 'req-1',
      requestSetId: 'set-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      maxOutputTokens: 123,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    });

    assert.equal(body.model, 'auto');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_tokens, 123);
    assert.deepEqual(body.metadata.context, {
      request_id: 'req-1',
      request_set_id: 'set-1',
      session_id: 'session-1',
      task_id: 'task-1',
      client_type: '5',
    });
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('builds bearer headers for direct private API calls', () => {
    assert.deepEqual(buildQoderPrivateHeaders({
      token: 'token-1',
      requestId: 'req-1',
      sessionId: 'session-1',
    }), {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-1',
      'X-Request-ID': 'req-1',
      'X-Session-ID': 'session-1',
    });
  });

  it('resolves the default model-server base URL', () => {
    assert.equal(qoderModelServerBaseUrl({}), 'https://api2-v2.qoder.sh/model/v1');
    assert.equal(
      qoderModelServerBaseUrl({ QODER_MODEL_SERVER_HOST: 'https://example.test/' }),
      'https://example.test/model/v1',
    );
  });

  it('surfaces Qoder private SSE error frames instead of reporting an empty response', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    globalThis.fetch = async () => new Response([
      'event: error',
      'data: {"code":"invalid_model_error","message":"Unsupported model \\"gm51model\\"","type":"invalid_model_error"}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        webContents: { send: () => {} },
        streamId: 's-qoder-error',
      });

      assert.equal(result.ok, false);
      assert.equal(result.providerError, true);
      assert.match(result.errorText, /provider_stream_error: Unsupported model "gm51model"/);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('unwraps Qoder legacy SSE envelopes before parsing OpenAI chunks', async () => {
    const sent = [];
    const inner = {
      choices: [{ delta: { content: 'OK', reasoning_content: 'thinking' }, index: 0 }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    const res = new Response([
      `data: ${JSON.stringify({ headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(inner), statusCodeValue: 200, statusCode: 'OK' })}`,
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const result = await consumeOpenAIStream(res, { send: (...args) => sent.push(args) }, 's-qoder-legacy');

    assert.equal(result.content, 'OK');
    assert.equal(result.thinkingContent, 'thinking');
    assert.deepEqual(result.streamUsage, {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(sent.some(([event]) => event === 'chat:stream:delta'), true);
    assert.equal(sent.some(([event]) => event === 'chat:stream:thinking'), true);
  });
});
