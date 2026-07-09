import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  normalizeQoderModel,
  normalizeQoderPreparedEndpoint,
  mergeConsecutiveAssistants,
  qoderModelServerBaseUrl,
  qoderTurnTaskId,
  sanitizeQoderToolPairing,
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
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
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
    assert.equal(body.tools[0].function.name, 'bash');
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

  it('normalizes complex tool schemas to a Qoder-compatible subset', () => {
    const body = buildQoderPrivateRequestBody({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'complex_tool',
          description: 'Complex tool.',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: ['string', 'null'], enum: ['read', 'write', null], default: 'read' },
              payload: {
                anyOf: [
                  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                  { type: 'string' },
                ],
              },
              files: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
            },
            required: ['mode', 'payload', 'missing'],
            unevaluatedProperties: false,
          },
        },
      }],
    });

    const parameters = body.tools[0].function.parameters;
    assert.deepEqual(parameters.required, ['mode', 'payload']);
    assert.deepEqual(parameters.properties.mode, { type: 'string', enum: ['read', 'write'] });
    assert.equal(parameters.properties.payload.type, 'object');
    assert.deepEqual(parameters.properties.payload.required, ['path']);
    assert.equal(parameters.properties.files.type, 'array');
    assert.equal(parameters.properties.files.items.type, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(parameters, 'unevaluatedProperties'), false);
  });

  it('normalizes historical tool-call arguments before sending them to Qoder', () => {
    const body = buildQoderPrivateRequestBody({
      model: 'auto',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_valid', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
            { id: 'call_bad', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}{"extra":1}' } },
            { id: 'call_object', type: 'function', function: { name: 'bash', arguments: { command: 'ls' } } },
          ],
        },
      ],
    });

    const [valid, bad, objectArgs] = body.messages[0].tool_calls;
    assert.deepEqual(JSON.parse(valid.function.arguments), { command: 'pwd' });
    assert.deepEqual(JSON.parse(bad.function.arguments), { raw_arguments: '{"command":"pwd"}{"extra":1}' });
    assert.deepEqual(JSON.parse(objectArgs.function.arguments), { command: 'ls' });
  });

  it('flattens Anthropic tool_use and tool_result blocks for Qoder history', () => {
    const body = buildQoderPrivateRequestBody({
      model: 'auto',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_call_0', name: 'bash', input: { command: 'pwd' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_call_0',
              content: [{ type: 'text', text: 'stdout: /tmp' }],
            },
          ],
        },
      ],
    });

    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: '[tool_use bash tool_call_0] {"command":"pwd"}' },
    ]);
    assert.deepEqual(body.messages[1].content, [
      { type: 'text', text: '[tool_result tool_call_0] stdout: /tmp' },
    ]);
    assert.equal(body.messages.some((message) => (
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
    )), false);
  });

  it('resolves the default model-server base URL', () => {
    assert.equal(qoderModelServerBaseUrl({}), 'https://api2-v2.qoder.sh/model/v1');
    assert.equal(
      qoderModelServerBaseUrl({ QODER_MODEL_SERVER_HOST: 'https://example.test/' }),
      'https://example.test/model/v1',
    );
  });

  it('does not reuse legacy chat completion endpoints for prepared infer requests', () => {
    assert.equal(
      normalizeQoderPreparedEndpoint('https://api2-v2.qoder.sh/model/v1/chat/completions'),
      null,
    );
    assert.equal(
      normalizeQoderPreparedEndpoint('https://api2-v2.qoder.sh/model/v1'),
      null,
    );
    assert.equal(
      normalizeQoderPreparedEndpoint('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation'),
      null,
    );
    assert.equal(
      normalizeQoderPreparedEndpoint('https://api3.qoder.sh/'),
      'https://api3.qoder.sh',
    );
    assert.equal(
      normalizeQoderPreparedEndpoint('https://proxy.example.test/qoder'),
      'https://proxy.example.test/qoder',
    );
  });

  it('surfaces Qoder private SSE error frames instead of reporting an empty response', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    globalThis.fetch = async () => new Response([
      'event: error',
      'data: {"code":"provider_error","message":"Failed to convert request","type":"provider_error","details":"failed to parse tool arguments"}',
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
      assert.match(result.errorText, /provider_stream_error: Failed to convert request: failed to parse tool arguments/);
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

  it('parses Anthropic-style Qoder SSE tool_use frames instead of dropping them as empty output', async () => {
    const sent = [];
    const frames = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_qoder_1","name":"bash","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"com"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"mand\\":\\"pwd\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
      '',
    ];
    const res = new Response(frames.join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const result = await consumeOpenAIStream(res, { send: (...args) => sent.push(args) }, 's-qoder-anthropic-tool');

    assert.equal(result.content, '');
    assert.deepEqual(result.toolCalls, [
      { id: 'toolu_qoder_1', name: 'bash', arguments: '{"command":"pwd"}' },
    ]);
    assert.equal(sent.some(([event]) => event === 'chat:stream:tool-progress'), true);
  });

  it('unwraps Qoder envelopes that contain Anthropic-style SSE events', async () => {
    const envelope = (inner) => JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: JSON.stringify(inner),
      statusCodeValue: 200,
      statusCode: 'OK',
    });
    const res = new Response([
      `data: ${envelope({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_qoder_2', name: 'bash', input: {} } })}`,
      `data: ${envelope({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } })}`,
      `data: ${envelope({ type: 'content_block_stop', index: 0 })}`,
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const result = await consumeOpenAIStream(res, { send: () => {} }, 's-qoder-envelope-anthropic-tool');

    assert.deepEqual(result.toolCalls, [
      { id: 'toolu_qoder_2', name: 'bash', arguments: '{"command":"ls"}' },
    ]);
  });

  it('sends tools to Qoder private API and parses returned tool calls', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}}]}}]}',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        webContents: { send: () => {} },
        streamId: 's-qoder-tool',
      });

      assert.equal(captured.url, 'https://example.test/model/v1/chat/completions');
      assert.equal(captured.body.tools[0].function.name, 'bash');
      assert.equal(result.ok, true);
      assert.equal(result.toolCalls[0].id, 'call_1');
      assert.equal(result.toolCalls[0].name, 'bash');
      assert.equal(result.toolCalls[0].arguments, '{"command":"pwd"}');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('does not stream literal tool_call text from Qoder into the UI', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"bash\\"}</tool_call>"}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-leaked-tool',
      });

      assert.equal(result.ok, true);
      assert.match(result.content, /<tool_call>/);
      assert.equal(events.some((event) => event.channel === 'chat:stream:delta'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('does not stream literal tool_call thinking deltas when buffering is requested', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"<tool_call>{\\"name\\":\\"bash\\",\\"input\\":{\\"command\\":\\"pwd\\"}}</tool_call>"}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-thinking-leaked-tool',
        bufferThinkingDeltas: true,
      });

      assert.equal(result.ok, true);
      assert.match(result.thinkingContent, /<tool_call>/);
      assert.equal(events.some((event) => event.channel === 'chat:stream:thinking'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('can suppress buffered Qoder thinking deltas before a terminal response is classified', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"I need to inspect files before answering."}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-suppressed-buffered-thinking',
        bufferThinkingDeltas: true,
        emitBufferedThinkingDeltas: false,
      });

      assert.equal(result.ok, true);
      assert.match(result.thinkingContent, /inspect files/);
      assert.equal(events.some((event) => event.channel === 'chat:stream:thinking'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('does not emit buffered Qoder thinking when the stream has no final text or tool calls', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"I will inspect the files before editing."}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-thinking-only-buffered',
        bufferThinkingDeltas: true,
      });

      assert.equal(result.ok, true);
      assert.match(result.thinkingContent, /inspect the files/);
      assert.equal(events.some((event) => event.channel === 'chat:stream:thinking'), false);
      assert.equal(events.some((event) => event.channel === 'chat:stream:delta'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('surfaces wrapped Qoder duplicate-request envelopes without waiting for idle timeout', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const encoder = new TextEncoder();
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          `data: ${JSON.stringify({
            headers: { 'Content-Type': ['application/json'] },
            body: JSON.stringify({ code: '103', message: 'Duplicate request' }),
            statusCodeValue: 403,
            statusCode: 'FORBIDDEN',
          })}`,
          '',
        ].join('\n')));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: () => {} },
        streamId: 's-qoder-duplicate-request-envelope',
        streamIdleTimeoutMs: 50,
      });

      assert.equal(result.ok, false);
      assert.equal(result.providerError, true);
      assert.match(result.errorText, /provider_stream_error: Duplicate request/);
      assert.doesNotMatch(result.errorText, /provider_stream_idle_timeout/);
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('reports a Qoder stream idle timeout when upstream stops sending after reasoning', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    const encoder = new TextEncoder();
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"reasoning_content":"Writing CascadingDropdown component..."}}]}\n\n',
        ));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-idle-timeout',
        bufferThinkingDeltas: true,
        streamIdleTimeoutMs: 5,
      });

      assert.equal(result.ok, false);
      assert.equal(result.providerError, true);
      assert.match(result.errorText, /provider_stream_error: provider_stream_idle_timeout/);
      assert.equal(cancelled, true);
      assert.equal(events.some((event) => event.channel === 'chat:stream:thinking'), false);
      assert.equal(events.some((event) => event.channel === 'chat:stream:delta'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('emits buffered Qoder thinking before buffered final text when enabled', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const events = [];
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"I should inspect the current state."}}]}',
      'data: {"choices":[{"delta":{"content":"done"}}]}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-buffered-thinking-before-text',
        bufferThinkingDeltas: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.content, 'done');
      assert.match(result.thinkingContent, /inspect/);
      assert.deepEqual(
        events
          .filter((event) => event.channel === 'chat:stream:thinking' || event.channel === 'chat:stream:delta')
          .map((event) => event.channel),
        ['chat:stream:thinking', 'chat:stream:delta'],
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('derives a unique task_id per turn while keeping the streamId prefix', () => {
    const streamId = 's-qoder-multi-turn';
    const first = qoderTurnTaskId(streamId);
    const second = qoderTurnTaskId(streamId);

    // Each turn must produce a distinct task_id so the Qoder gateway does not
    // reject follow-up turns (e.g. the edit_file call) with Duplicate request(103).
    assert.notEqual(first, second);
    assert.ok(first.startsWith(`${streamId}:`));
    assert.ok(second.startsWith(`${streamId}:`));
  });

  it('falls back to a peer-agent prefixed unique task_id when streamId is missing', () => {
    const first = qoderTurnTaskId(undefined);
    const second = qoderTurnTaskId('');

    assert.ok(first.startsWith('peer-agent:'));
    assert.ok(second.startsWith('peer-agent:'));
    assert.notEqual(first, second);
  });

  describe('sanitizeQoderToolPairing', () => {
    it('drops orphan tool_result whose tool_use header was trimmed away', () => {
      // Reproduces the ultimate/Anthropic error:
      // "unexpected tool_use_id found in tool_result blocks".
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'do it' },
        { role: 'tool', tool_call_id: 'call_orphan', content: 'result without its call' },
        { role: 'assistant', content: 'ok' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.deepEqual(sanitized, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: 'ok' },
      ]);
      assert.equal(sanitized.some((m) => m.role === 'tool'), false);
    });

    it('keeps properly paired tool_use / tool_result messages', () => {
      const messages = [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'output' },
        { role: 'assistant', content: 'done' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.equal(sanitized.length, 4);
      const assistantCall = sanitized[1];
      assert.equal(assistantCall.tool_calls.length, 1);
      assert.equal(assistantCall.tool_calls[0].id, 'call_1');
      assert.equal(sanitized[2].tool_call_id, 'call_1');
    });

    it('strips mid-conversation dangling tool_calls whose result was trimmed but keeps assistant text', () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'let me check', tool_calls: [{ id: 'call_missing', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'user', content: 'next question' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.equal(sanitized.length, 3);
      assert.equal(sanitized[1].content, 'let me check');
      assert.equal(sanitized[1].tool_calls, undefined);
    });

    it('keeps a trailing assistant tool_call (pending result) untouched', () => {
      // The last assistant may legitimately hold a tool_use awaiting its result;
      // Anthropic only rejects orphan tool_result, not a trailing tool_use.
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_pending', function: { name: 'bash', arguments: '{}' } }] },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.equal(sanitized.length, 2);
      assert.equal(sanitized[1].tool_calls.length, 1);
      assert.equal(sanitized[1].tool_calls[0].id, 'call_pending');
    });

    it('drops assistant entirely when it only carries a dangling tool_call with no text', () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_missing', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'user', content: 'still there?' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.deepEqual(sanitized, [
        { role: 'user', content: 'go' },
        { role: 'user', content: 'still there?' },
      ]);
    });

    it('keeps only the paired subset when one of several calls lost its result', () => {
      const messages = [
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_a', function: { name: 'bash', arguments: '{}' } },
          { id: 'call_b', function: { name: 'read', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_a', content: 'a-result' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);

      assert.equal(sanitized.length, 2);
      assert.equal(sanitized[0].tool_calls.length, 1);
      assert.equal(sanitized[0].tool_calls[0].id, 'call_a');
      assert.equal(sanitized[1].tool_call_id, 'call_a');
    });

    it('guarantees every remaining tool_result has a preceding tool_use (Anthropic invariant)', () => {
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'tool', tool_call_id: 'call_orphan', content: 'orphan' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_ok', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_ok', content: 'ok' },
      ];

      const sanitized = sanitizeQoderToolPairing(messages);
      const declared = new Set();
      for (const m of sanitized) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) declared.add(c.id);
        }
        if (m.role === 'tool') {
          assert.ok(declared.has(m.tool_call_id), `tool_result ${m.tool_call_id} must have a preceding tool_use`);
        }
      }
    });
  });

  describe('mergeConsecutiveAssistants', () => {
    it('merges a narration assistant + a content:null tool_calls assistant (the real ultimate bug)', () => {
      // Reproduces the exact shape from the [qoder-debug] logs:
      //   1:assistant(text) | 2:assistant(content:null, tc[call_d66750]) | 3:tool(call_d66750)
      const messages = [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: '用户提出了一个清晰的改进目标' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_d66750', function: { name: 'batch_search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_d66750', content: 'search result' },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      assert.equal(merged.length, 3);
      assert.equal(merged[0].role, 'user');
      assert.equal(merged[1].role, 'assistant');
      // text preserved, tool_calls preserved, content is NOT null
      assert.equal(merged[1].content, '用户提出了一个清晰的改进目标');
      assert.equal(merged[1].tool_calls.length, 1);
      assert.equal(merged[1].tool_calls[0].id, 'call_d66750');
      assert.notEqual(merged[1].content, null);
      assert.equal(merged[2].role, 'tool');
    });

    it('never emits content:null on a standalone tool-calling assistant', () => {
      const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_x', content: 'ok' },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      assert.equal(merged[1].content, '');
      assert.notEqual(merged[1].content, null);
      assert.equal(merged[1].tool_calls[0].id, 'call_x');
    });

    it('concatenates text from two plain assistant messages', () => {
      const messages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'part one' },
        { role: 'assistant', content: 'part two' },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      assert.equal(merged.length, 2);
      assert.equal(merged[1].content, 'part one\n\npart two');
    });

    it('merges tool_calls from two consecutive tool-calling assistants', () => {
      const messages = [
        { role: 'assistant', content: 'first', tool_calls: [{ id: 'call_a', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_b', function: { name: 'read', arguments: '{}' } }] },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      assert.equal(merged.length, 1);
      assert.equal(merged[0].tool_calls.length, 2);
      assert.deepEqual(merged[0].tool_calls.map((t) => t.id), ['call_a', 'call_b']);
      assert.equal(merged[0].content, 'first');
    });

    it('leaves already-alternating conversations untouched in role order', () => {
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      assert.deepEqual(merged.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant']);
    });

    it('collapses a full multi-tool-round history into strict user/assistant/tool alternation', () => {
      const messages = [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'narration 1' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
        { role: 'assistant', content: 'narration 2' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_2', content: 'r2' },
      ];

      const merged = mergeConsecutiveAssistants(messages);

      // No two consecutive assistant messages should remain.
      for (let i = 1; i < merged.length; i += 1) {
        assert.ok(
          !(merged[i].role === 'assistant' && merged[i - 1].role === 'assistant'),
          `messages ${i - 1} and ${i} are both assistant`,
        );
      }
      // Every tool-calling assistant carries non-null content.
      for (const m of merged) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          assert.notEqual(m.content, null);
        }
      }
    });
  });
});
