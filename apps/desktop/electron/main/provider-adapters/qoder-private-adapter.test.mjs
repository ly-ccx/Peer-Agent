import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  buildQoderRemoteChatAsk,
  classifyQoderStreamFailure,
  computeQoderQueueWaitMs,
  formatQoderDuplicateError,
  formatQoderQueueError,
  formatQoderQueueStatusMessage,
  normalizeQoderModel,
  normalizeQoderPreparedEndpoint,
  mergeConsecutiveAssistants,
  qoderModelServerBaseUrl,
  qoderTurnTaskId,
  resolveQoderReasoningEffortParam,
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
      {
        role: 'user',
        content: 'hello',
        contents: [{ type: 'text', text: 'hello' }],
      },
    ]);
    assert.equal(body.tools[0].function.name, 'bash');
  });

  it('aligns remote FREE_INPUT messages with qodercli contents/system shape', () => {
    const body = buildQoderRemoteChatAsk({
      model: 'ultimate',
      requestId: 'req-ultimate',
      requestSetId: 'set-ultimate',
      sessionId: 'session-ultimate',
      taskId: 'task-ultimate',
      maxOutputTokens: 32768,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '测试一下' },
        { role: 'assistant', content: 'ok' },
      ],
      metadata: {
        id: 'ultimate',
        label: 'Ultimate',
        source: 'system',
        format: 'openai',
        supportsVision: true,
        supportsReasoning: true,
        contextWindow: 1_000_000,
      },
    });

    assert.equal(body.system, 'system prompt');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'system prompt');
    assert.deepEqual(body.messages[1], {
      role: 'user',
      content: '测试一下',
      contents: [{ type: 'text', text: '测试一下' }],
    });
    assert.deepEqual(body.messages[2], {
      role: 'assistant',
      content: 'ok',
      contents: [{ type: 'text', text: 'ok' }],
    });
    assert.equal(body.model_config.key, 'ultimate');
    assert.equal(body.parameters.max_tokens, 32768);
    assert.deepEqual(body.business, {});
  });

  it('keeps image_url parts in both content and contents for vision user messages', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7tUAAAAASUVORK5CYII=';
    const body = buildQoderRemoteChatAsk({
      model: 'ultimate',
      requestId: 'req-vl',
      requestSetId: 'set-vl',
      sessionId: 'session-vl',
      taskId: 'task-vl',
      messages: [
        { role: 'system', content: 'system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图里有什么？' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      metadata: {
        id: 'ultimate',
        label: 'Ultimate',
        source: 'system',
        format: 'openai',
        supportsVision: true,
        supportsReasoning: false,
      },
    });

    const user = body.messages.find((message) => message.role === 'user');
    // qodercli 1.1.7 对带图 user 消息：content 与 contents 都携带 image_url 分片。
    assert.deepEqual(user.content, [
      { type: 'text', text: '这张图里有什么？' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
    assert.deepEqual(user.contents, [
      { type: 'text', text: '这张图里有什么？' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
    assert.equal(body.model_config.is_vl, true);
  });

  it('keeps image-only user contents non-empty so upstream sees the image', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const body = buildQoderRemoteChatAsk({
      model: 'ultimate',
      requestId: 'req-vl2',
      requestSetId: 'set-vl2',
      sessionId: 'session-vl2',
      taskId: 'task-vl2',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: dataUrl } }],
        },
      ],
      metadata: {
        id: 'ultimate',
        label: 'Ultimate',
        source: 'system',
        format: 'openai',
        supportsVision: true,
        supportsReasoning: false,
      },
    });

    const user = body.messages.find((message) => message.role === 'user');
    assert.deepEqual(user.contents, [
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
  });

  it('uses empty contents for tool-only assistant and drops empty user messages', () => {
    const body = buildQoderRemoteChatAsk({
      model: 'kmodel_latest',
      requestId: 'req-kimi',
      requestSetId: 'set-kimi',
      sessionId: 'session-kimi',
      taskId: 'task-kimi',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'run pwd' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"pwd"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '/tmp' },
        { role: 'user', content: '' },
        { role: 'user', content: '测试2' },
      ],
      metadata: {
        id: 'kmodel_latest',
        label: 'Kimi-K3',
        source: 'system',
        format: 'openai',
        supportsVision: true,
        supportsReasoning: false,
        contextWindow: 1_000_000,
      },
    });

    const assistant = body.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content, '');
    assert.deepEqual(assistant.contents, []);
    assert.equal(assistant.tool_calls[0].id, 'call_1');
    assert.equal(body.messages.some((message) => message.role === 'user' && message.content === ''), false);
    assert.deepEqual(body.messages.at(-1), {
      role: 'user',
      content: '测试2',
      contents: [{ type: 'text', text: '测试2' }],
    });
  });

  it('projects a selected context tier into Qoder model_config', () => {
    const metadata = {
      contextWindow: 180000,
      modelOptions: [{
        id: 'contextTier',
        kind: 'select',
        defaultValue: '200K',
        choices: [
          { value: '200K', requestValue: '200K', contextWindow: 200000, inputTokenLimit: 180000 },
          { value: '1M', requestValue: '1M', contextWindow: 1000000, inputTokenLimit: 980000 },
        ],
      }],
    };
    const body = buildQoderRemoteChatAsk({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hello' }],
      metadata,
      modelOptionValues: { contextTier: '1M' },
    });

    assert.equal(body.model_config.max_input_tokens, 1000000);
    assert.equal(body.model_config.contextTier, '1M');
  });

  it('maps peer effort to parameters.reasoning_effort and enables is_reasoning', () => {
    assert.equal(resolveQoderReasoningEffortParam('off'), 'none');
    assert.equal(resolveQoderReasoningEffortParam('max'), 'max');
    assert.equal(
      resolveQoderReasoningEffortParam('default', { reasoningDefaultEffort: 'high' }),
      'high',
    );

    const performanceBody = buildQoderRemoteChatAsk({
      model: 'performance',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: {
        id: 'performance',
        supportsReasoning: true,
        reasoningDefaultEffort: 'medium',
        reasoningEffortLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        contextWindow: 272000,
      },
      effort: 'xhigh',
    });
    assert.equal(performanceBody.parameters.reasoning_effort, 'xhigh');
    assert.equal(performanceBody.model_config.is_reasoning, true);

    const offBody = buildQoderRemoteChatAsk({
      model: 'ultimate',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: {
        id: 'ultimate',
        supportsReasoning: true,
        reasoningDefaultEffort: 'high',
        contextWindow: 1000000,
      },
      effort: 'off',
    });
    assert.equal(offBody.parameters.reasoning_effort, 'none');
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

  it('routes catalog-missing models with modelOptions through agent_chat_generation', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return new Response([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://api2-v2.qoder.sh/model/v1',
        apiKey: 'token',
        model: 'kmodel_latest',
        messages: [{ role: 'user', content: '测试2' }],
        modelOptions: [{
          id: 'contextTier',
          kind: 'select',
          choices: [{ value: '1M', contextWindow: 1_000_000, inputTokenLimit: 980_000 }],
        }],
        modelOptionValues: { contextTier: '1M' },
        webContents: { send: () => {} },
        streamId: 's-qoder-kmodel-route',
      });

      assert.equal(result.ok, true);
      assert.match(capturedUrl, /agent_chat_generation/);
      assert.doesNotMatch(capturedUrl, /\/model\/v1\/chat\/completions/);
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
        // Disable 103 auto-retry so this case only asserts envelope parsing latency.
        transientRetryDelaysMs: [],
        duplicateRetryDelaysMs: [],
      });

      assert.equal(result.ok, false);
      assert.equal(result.providerError, true);
      assert.match(result.errorText, /qoder_duplicate_request|provider_stream_error: Duplicate request/);
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

  it('classifies 10605 queue payloads and caps wait time', () => {
    const queued = classifyQoderStreamFailure(
      'provider_stream_error: {"code":"10605","message":{"isQueued":true,"queueType":"slow","waitTime":15228,"queueCount":12,"serviceAvailable":false}}',
    );
    assert.equal(queued.kind, 'queued');
    assert.equal(queued.code, '10605');
    assert.equal(queued.queueType, 'slow');
    // waitTime is seconds upstream: 15228s -> ms.
    assert.equal(queued.waitTimeMs, 15_228_000);
    assert.equal(queued.queueCount, 12);
    assert.equal(queued.serviceAvailable, false);
    // No retryAfterSeconds: poll cadence falls back to the capped default.
    assert.equal(computeQoderQueueWaitMs(queued), 15_000);
    assert.equal(computeQoderQueueWaitMs({ waitTimeMs: 999_999 }), 15_000);

    // retryAfterSeconds is the authoritative poll cadence.
    const withCadence = classifyQoderStreamFailure(
      'provider_stream_error: {"code":"10605","message":{"isQueued":true,"queueType":"p4","queueCount":917,"retryAfterSeconds":30,"waitTime":189,"serviceAvailable":true}}',
    );
    assert.equal(withCadence.retryAfterMs, 30_000);
    assert.equal(withCadence.waitTimeMs, 189_000);
    assert.equal(withCadence.queueCount, 917);
    assert.equal(computeQoderQueueWaitMs(withCadence), 30_000);
    // Single wait is capped even when cadence is huge.
    assert.equal(computeQoderQueueWaitMs({ retryAfterMs: 999_999 }), 60_000);

    const status = formatQoderQueueStatusMessage(queued, {
      attempt: 1,
      maxAttempts: 3,
      waitTimeMs: 15_228,
    });
    assert.match(status, /Qoder slow busy/);
    assert.match(status, /position ~12/);
    assert.match(status, /retry 1\/3/);
    assert.match(status, /service marked unavailable/);

    const timeoutText = formatQoderQueueError('upstream', {
      attempts: 3,
      waitTimeMs: 120_000,
      upstreamWaitTimeMs: 3_814_000,
      queueType: 'slow',
      queueCount: 402,
      serviceAvailable: false,
    });
    assert.match(timeoutText, /qoder_queue_timeout/);
    assert.match(timeoutText, /position ~402/);
    assert.match(timeoutText, /serviceAvailable=false/);
    assert.match(timeoutText, /try another model/);

    const transient = classifyQoderStreamFailure('provider_stream_error: Rate limit exceeded: tpm (OutputTokens)');
    assert.equal(transient.kind, 'transient');

    const duplicate = classifyQoderStreamFailure('provider_stream_error: Duplicate request', {
      type: '103',
      message: 'Duplicate request',
    });
    assert.equal(duplicate.kind, 'transient');
    assert.equal(duplicate.code, '103');
    assert.equal(duplicate.reason, 'duplicate');
    assert.match(formatQoderDuplicateError('Duplicate request', { attempts: 2 }), /qoder_duplicate_request/);

    const fatal = classifyQoderStreamFailure('provider_stream_error: Failed to convert request');
    assert.equal(fatal.kind, null);
  });

  it('waits and retries when Qoder reports 10605 isQueued', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let calls = 0;
    const events = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response([
          'data: {"code":"10605","message":{"isQueued":true,"queueType":"slow","waitTime":20,"queueCount":3}}',
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response([
        'data: {"choices":[{"delta":{"content":"ready"}}]}',
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
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's-qoder-queue-retry',
        maxQueueRetries: 2,
        transientRetryDelaysMs: [],
        waitImpl: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.content, 'ready');
      assert.equal(calls, 2);
      assert.ok(events.some((event) => event.channel === 'chat:stream:status' && event.payload?.status === 'queued'));
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('surfaces qoder_queue_timeout after exhausting queue waits', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response([
        'data: {"code":"10605","message":{"isQueued":true,"queueType":"slow","waitTime":15,"queueCount":99}}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        webContents: { send: () => {} },
        streamId: 's-qoder-queue-exhausted',
        maxQueueRetries: 1,
        transientRetryDelaysMs: [],
        waitImpl: async () => {},
      });

      assert.equal(result.ok, false);
      assert.equal(result.queueExhausted, true);
      assert.match(result.errorText, /qoder_queue_timeout/);
      assert.equal(calls, 2); // initial + 1 retry
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('waits out the Qoder queue on the upstream cadence until the time budget runs out', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response([
        'data: {"code":"10605","message":{"isQueued":true,"queueType":"p4","queueCount":917,"retryAfterSeconds":30,"waitTime":189,"serviceAvailable":true}}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const waits = [];
    const events = [];
    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
        streamId: 's-qoder-queue-budget',
        // Budget 45s with a 30s cadence: first wait 30s, second clamped to the
        // remaining 15s, then the budget is spent and the run terminates.
        queueBudgetMs: 45_000,
        maxQueueRetries: 40,
        transientRetryDelaysMs: [],
        duplicateRetryDelaysMs: [],
        waitImpl: async (ms) => { waits.push(ms); },
      });

      assert.equal(result.ok, false);
      assert.equal(result.queueExhausted, true);
      // Polls at the upstream cadence (30s), then clamped by remaining budget.
      assert.deepEqual(waits, [30_000, 15_000]);
      assert.equal(calls, 3); // initial + 2 polls
      // Queue status events carry the real queue depth + upstream estimate.
      const queuedEvents = events.filter((event) => (
        event.channel === 'chat:stream:status' && event.payload?.status === 'queued'
      ));
      assert.equal(queuedEvents.length, 2);
      assert.equal(queuedEvents[0].payload.queueCount, 917);
      assert.equal(queuedEvents[0].payload.upstreamWaitTimeMs, 189_000);
      assert.equal(queuedEvents[0].payload.waitMs, 30_000);
      assert.equal(queuedEvents[1].payload.waitedMs, 30_000);
      assert.equal(queuedEvents[1].payload.waitMs, 15_000);
      // Terminal error reports how long we actually waited in queue.
      assert.match(result.errorText, /waited 45s in queue/);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });


  it('marks is_retry when buildQoderRemoteChatAsk isRetry is true', () => {
    const first = buildQoderRemoteChatAsk({
      model: 'ultimate',
      requestId: 'req-a',
      requestSetId: 'req-a',
      sessionId: 'session-a',
      taskId: 'task-a',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const retry = buildQoderRemoteChatAsk({
      model: 'ultimate',
      requestId: 'req-b',
      requestSetId: 'req-b',
      sessionId: 'session-b',
      taskId: 'task-b',
      isRetry: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(first.is_retry, false);
    assert.equal(retry.is_retry, true);
    assert.notEqual(first.request_id, retry.request_id);
  });

  it('regenerates request_id on connection recovery retries', async () => {
    // Exercise the legacy private path (no catalog metadata) so prepareQoderInferRequest
    // is not required. Connection recovery must still rebuild a fresh request_id /
    // session_id rather than replaying the first timed-out attempt.
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    const requestIds = [];
    const sessionIds = [];
    const headerRequestIds = [];
    let calls = 0;

    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init.body || '{}'));
      const context = body?.metadata?.context || {};
      requestIds.push(context.request_id);
      sessionIds.push(context.session_id);
      headerRequestIds.push(init.headers?.['X-Request-ID'] || init.headers?.['x-request-id']);
      if (calls === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ETIMEDOUT' };
        throw error;
      }
      return new Response([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        webContents: { send: () => {} },
        streamId: 's-qoder-retry-ids',
        maxQueueRetries: 0,
        transientRetryDelaysMs: [],
        waitImpl: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(calls, 2);
      assert.equal(requestIds.length, 2);
      assert.ok(requestIds[0]);
      assert.ok(requestIds[1]);
      assert.notEqual(requestIds[0], requestIds[1]);
      assert.notEqual(sessionIds[0], sessionIds[1]);
      assert.notEqual(headerRequestIds[0], headerRequestIds[1]);
      assert.equal(headerRequestIds[0], requestIds[0]);
      assert.equal(headerRequestIds[1], requestIds[1]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('auto-retries 103 Duplicate request with a fresh request id', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let calls = 0;
    const requestIds = [];
    const events = [];
    globalThis.fetch = async (_url, init = {}) => {
      calls += 1;
      const body = JSON.parse(String(init.body || '{}'));
      const headers = init.headers || {};
      requestIds.push(
        body?.metadata?.context?.request_id
        || body?.request_id
        || headers['X-Request-ID']
        || headers['x-request-id']
        || null,
      );
      if (calls === 1) {
        return new Response([
          'data: {"code":"103","message":"Duplicate request"}',
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response([
        'data: {"choices":[{"delta":{"content":"ok-after-dup"}}]}',
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
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
        streamId: 's-qoder-duplicate-retry',
        maxQueueRetries: 0,
        duplicateRetryDelaysMs: [5],
        waitImpl: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(calls, 2);
      assert.equal(requestIds.length, 2);
      assert.notEqual(requestIds[0], requestIds[1]);
      assert.ok(events.some((event) => (
        event.channel === 'chat:stream:status'
        && event.payload?.status === 'retrying'
        && event.payload?.code === '103'
      )));
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('surfaces qoder_duplicate_request after exhausting 103 retries', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response([
        'data: {"code":"103","message":"Duplicate request"}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    try {
      const result = await sendQoderPrivateStream({
        baseUrl: 'https://example.test/model/v1',
        apiKey: 'token',
        model: 'unsupported-model',
        messages: [{ role: 'user', content: 'hi' }],
        webContents: { send: () => {} },
        streamId: 's-qoder-duplicate-exhausted',
        maxQueueRetries: 0,
        duplicateRetryDelaysMs: [1],
        waitImpl: async () => {},
      });

      assert.equal(result.ok, false);
      assert.equal(result.duplicateExhausted, true);
      assert.match(result.errorText, /qoder_duplicate_request/);
      // Single bounded retry: initial + 1 retry, then a terminal error.
      assert.equal(calls, 2);
      assert.match(result.errorText, /after 1 retry attempt/);
      assert.match(result.errorText, /further retries will not help/);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });


});
