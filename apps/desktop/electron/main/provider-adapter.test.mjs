import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
import { sendGeminiStream } from './provider-adapters/gemini-adapter.mjs';
import { sendOpenAIChatStream } from './provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from './provider-adapters/openai-responses-adapter.mjs';

function sse(frames) {
  return frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
}

function streamFromChunks(chunks, { onCancel } = {}) {
  const encoder = new TextEncoder();
  let controllerRef = null;
  let cancelled = false;
  return {
    stream: new ReadableStream({
      start(controller) {
        controllerRef = controller;
        if (chunks.length > 0) {
          controller.enqueue(encoder.encode(chunks.shift()));
        }
      },
      cancel() {
        cancelled = true;
        onCancel?.();
      },
    }),
    enqueueNext() {
      if (!controllerRef || chunks.length === 0 || cancelled) return;
      try {
        controllerRef.enqueue(encoder.encode(chunks.shift()));
        if (chunks.length === 0) controllerRef.close();
      } catch {
        // Abort-aware readers cancel the stream before this delayed chunk arrives.
      }
    },
  };
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('Provider adapters', () => {
  it('sends an OpenAI chat request and parses deltas, tool calls, and usage', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { choices: [{ delta: { content: 'hello' } }] },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tool-1',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"pwd"}' },
              }],
            },
          }],
        },
        {
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const result = await sendOpenAIChatStream({
        baseUrl: 'https://example.test/v1/',
        apiKey: 'key',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash' } }],
        effort: 'high',
        supportsReasoning: true,
        maxOutputTokens: 8192,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's1',
      });

      assert.equal(captured.url, 'https://example.test/v1/chat/completions');
      assert.equal(captured.init.headers.Authorization, 'Bearer key');
      assert.equal(captured.body.model, 'gpt-test');
      assert.equal(captured.body.reasoning_effort, 'high');
      assert.equal(captured.body.max_tokens, 8192);
      assert.equal(result.ok, true);
      assert.equal(result.content, 'hello');
      assert.equal(result.toolCalls[0].name, 'bash');
      assert.equal(result.toolCalls[0].arguments, '{"command":"pwd"}');
      assert.equal(result.streamUsage.inputTokens, 7);
      assert.equal(result.streamUsage.inputTokens + result.streamUsage.cacheReadTokens, 10);
      assert.equal(events.find((event) => event.channel === 'chat:stream:delta').payload.content, 'hello');
      assert.equal(events.find((event) => event.channel === 'chat:stream:usage').payload.usage.cacheReadTokens, 3);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('maps DeepSeek prompt cache hit tokens from OpenAI-compatible usage', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async () => {
      return new Response(sse([
        {
          choices: [{ delta: { content: 'ok' } }],
        },
        {
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const result = await sendOpenAIChatStream({
        baseUrl: 'https://api.deepseek.test/v1',
        apiKey: 'key',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'off',
        supportsReasoning: false,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 'deepseek-cache',
      });

      assert.equal(result.ok, true);
      assert.equal(result.streamUsage.inputTokens, 20);
      assert.equal(result.streamUsage.cacheReadTokens, 80);
      assert.equal(result.streamUsage.inputTokens + result.streamUsage.cacheReadTokens, 100);
      assert.equal(events.find((event) => event.channel === 'chat:stream:usage').payload.usage.cacheReadTokens, 80);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('cancels the OpenAI chat SSE reader when the chat stream is aborted', async () => {
    const previousFetch = globalThis.fetch;
    const abortController = new AbortController();
    const events = [];
    let readerCancelled = false;
    let pendingStream = null;

    globalThis.fetch = async () => {
      pendingStream = streamFromChunks([
        sse([{ choices: [{ delta: { content: 'first' } }] }]),
        sse([{ choices: [{ delta: { content: 'late' } }] }, '[DONE]']),
      ], {
        onCancel: () => {
          readerCancelled = true;
        },
      });
      return new Response(pendingStream.stream, { status: 200 });
    };

    try {
      await assert.rejects(
        sendOpenAIChatStream({
          baseUrl: 'https://example.test/v1',
          apiKey: 'key',
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          effort: 'off',
          supportsReasoning: false,
          signal: abortController.signal,
          webContents: {
            send: (channel, payload) => {
              events.push({ channel, payload });
              if (channel === 'chat:stream:delta' && payload.content === 'first') {
                abortController.abort();
                setTimeout(() => pendingStream?.enqueueNext(), 20);
              }
            },
          },
          streamId: 'openai-abort',
        }),
        { name: 'AbortError' },
      );

      assert.equal(readerCancelled, true);
      assert.deepEqual(
        events
          .filter((event) => event.channel === 'chat:stream:delta')
          .map((event) => event.payload.content),
        ['first'],
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('does not send OpenAI native reasoning parameters without provider capability', async () => {
    const previousFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { choices: [{ delta: { content: 'ok' } }] },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const result = await sendOpenAIChatStream({
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'high',
        supportsReasoning: false,
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      assert.equal(captured.body.reasoning_effort, undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('parses OpenAI-compatible reasoning deltas as thinking content', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { reasoning_content: '先思考' } }] },
      { choices: [{ delta: { thinking: { content: '再判断' } } }] },
      '[DONE]',
    ]), { status: 200 });

    try {
      const result = await sendOpenAIChatStream({
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'high',
        supportsReasoning: true,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      assert.equal(result.content, '');
      assert.equal(result.thinkingContent, '先思考再判断');
      assert.deepEqual(
        events
          .filter((event) => event.channel === 'chat:stream:thinking')
          .map((event) => event.payload.content),
        ['先思考', '再判断'],
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('sends an Anthropic messages request and parses text, tool use, and usage', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 11,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 5,
            },
          },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'bash' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      ]), { status: 200 });
    };

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://example.test/',
        apiKey: 'key',
        model: 'claude-test',
        system: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'bash' }],
        effort: 'high',
        supportsReasoning: true,
        promptCaching: true,
        maxOutputTokens: 4096,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's1',
      });

      assert.equal(captured.url, 'https://example.test/v1/messages');
      assert.equal(captured.init.headers['x-api-key'], 'key');
      assert.ok(Array.isArray(captured.body.system));
      assert.equal(captured.body.system[0].text, 'system');
      assert.equal(captured.body.system[0].cache_control.type, 'ephemeral');
      assert.equal(captured.body.thinking.type, 'enabled');
      assert.equal(captured.body.max_tokens, 32768 + 4096);
      assert.equal(result.ok, true);
      assert.equal(result.textContent, 'hello');
      assert.equal(result.stopReason, 'tool_use');
      assert.equal(result.toolUseBlocks[0].id, 'tool-1');
      assert.equal(result.toolUseBlocks[0].inputJson, '{"command":"pwd"}');
      assert.equal(result.streamUsage.inputTokens, 11);
      assert.equal(result.streamUsage.outputTokens, 7);
      assert.equal(events.find((event) => event.channel === 'chat:stream:delta').payload.content, 'hello');
      assert.equal(events.find((event) => event.channel === 'chat:stream:usage').payload.usage.cacheReadTokens, 5);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('does not send Anthropic thinking without provider capability', async () => {
    const previousFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://example.test',
        apiKey: 'key',
        model: 'claude-test',
        system: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'high',
        supportsReasoning: false,
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      assert.equal(result.textContent, 'ok');
      assert.equal(captured.body.thinking, undefined);
      assert.equal(captured.body.max_tokens, 16384);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('uses adaptive Anthropic thinking when descriptor reasoning style requests it', async () => {
    const previousFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
        apiKey: 'key',
        model: 'claude-test',
        system: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'high',
        supportsReasoning: true,
        reasoningParamStyle: 'anthropic-adaptive-effort',
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      assert.deepEqual(captured.body.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(captured.body.output_config, { effort: 'high' });
      assert.equal(captured.body.max_tokens, 16384);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('omits cache_control breakpoints when promptCaching is disabled (default off)', async () => {
    const previousFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'key',
        model: 'claude-test',
        system: 'stable system prefix',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'latest question' },
        ],
        tools: [],
        effort: 'default',
        supportsReasoning: true,
        promptCaching: false,
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      // system 保持字符串, 不降为带 cache_control 的 block 数组。
      assert.equal(typeof captured.body.system, 'string');
      for (const msg of captured.body.messages) {
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          assert.equal(block.cache_control, undefined);
        }
      }
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('keeps cache_control breakpoints when promptCaching is explicitly enabled', async () => {
    const previousFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'key',
        model: 'claude-test',
        system: 'stable system prefix',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'latest question' },
        ],
        tools: [],
        effort: 'default',
        supportsReasoning: true,
        promptCaching: true,
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, true);
      assert.ok(Array.isArray(captured.body.system));
      assert.equal(captured.body.system[0].cache_control.type, 'ephemeral');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('returns Anthropic SSE error events as provider stream errors', async () => {
    const previousFetch = globalThis.fetch;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    globalThis.fetch = async () => new Response([
      'event: error',
      'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad thinking"}}',
      '',
    ].join('\n'), { status: 200 });

    try {
      const result = await sendAnthropicMessagesStream({
        baseUrl: 'https://example.test',
        apiKey: 'key',
        model: 'claude-test',
        system: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'high',
        supportsReasoning: true,
        webContents: { send: () => {} },
        streamId: 's1',
      });

      assert.equal(result.ok, false);
      assert.equal(result.providerError, true);
      assert.match(result.errorText, /provider_stream_error: bad thinking/);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  });

  it('normalizes OpenAI Responses cached input without double counting context tokens', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async () => new Response(sse([
      { type: 'response.output_text.delta', delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 80 },
          },
        },
      },
      '[DONE]',
    ]), { status: 200 });

    try {
      const result = await sendOpenAIResponsesStream({
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        accountId: 'acct_1',
        model: 'gpt-responses',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        effort: 'off',
        supportsReasoning: false,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 'responses-cache',
      });

      assert.equal(result.ok, true);
      assert.equal(result.streamUsage.inputTokens, 20);
      assert.equal(result.streamUsage.cacheReadTokens, 80);
      assert.equal(result.streamUsage.inputTokens + result.streamUsage.cacheReadTokens, 100);
      assert.equal(events.find((event) => event.channel === 'chat:stream:usage').payload.usage.inputTokens, 20);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('records an OpenAI Responses anomaly trace when output_text delta contains pseudo tool-call text', async () => {
    const previousFetch = globalThis.fetch;
    const previousHome = process.env.PEER_AGENT_HOME;
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-provider-trace-'));
    const events = [];
    let captured = null;

    process.env.PEER_AGENT_HOME = tempHome;
    process.env.PEER_AGENT_PROVIDER_TRACE = '1';
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        { type: 'response.output_text.delta', delta: '<functions.bash agext={{"command":"pwd"}} />' },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const result = await sendOpenAIResponsesStream({
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        accountId: 'acct_1',
        model: 'gpt-responses',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        effort: 'medium',
        supportsReasoning: true,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 'responses-pseudo-tool',
      });

      assert.equal(result.ok, true);
      assert.equal(result.pseudoToolTextDetected, true);
      assert.equal(captured.url, 'https://example.test/v1/responses');
      assert.equal(captured.init.headers['chatgpt-account-id'], 'acct_1');
      assert.equal(events.find((event) => event.channel === 'chat:stream:delta').payload.content, '<functions.bash agext={{"command":"pwd"}} />');
      assert.ok(result.providerTracePath);

      const traces = await readJsonl(result.providerTracePath);
      const trace = traces.at(-1);
      assert.equal(trace.provider, 'openai-responses');
      assert.equal(trace.anomaly, 'pseudo_tool_text_delta');
      assert.equal(trace.result.pseudoToolTextDetected, true);
      const deltaEvent = trace.events.find((event) => event.summary?.type === 'response.output_text.delta');
      assert.ok(deltaEvent);
      assert.match(deltaEvent.rawPreview, /<functions\.bash/);
      assert.equal(deltaEvent.summary.deltaChars, '<functions.bash agext={{"command":"pwd"}} />'.length);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
      else process.env.PEER_AGENT_HOME = previousHome;
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('cancels the OpenAI Responses SSE reader when the chat stream is aborted', async () => {
    const previousFetch = globalThis.fetch;
    const abortController = new AbortController();
    const events = [];
    let readerCancelled = false;
    let pendingStream = null;

    globalThis.fetch = async () => {
      pendingStream = streamFromChunks([
        sse([{ type: 'response.output_text.delta', delta: 'first' }]),
        sse([{ type: 'response.output_text.delta', delta: 'late' }, '[DONE]']),
      ], {
        onCancel: () => {
          readerCancelled = true;
        },
      });
      return new Response(pendingStream.stream, { status: 200 });
    };

    try {
      await assert.rejects(
        sendOpenAIResponsesStream({
          baseUrl: 'https://example.test/v1',
          apiKey: 'key',
          accountId: 'acct_1',
          model: 'gpt-responses',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          effort: 'off',
          supportsReasoning: false,
          signal: abortController.signal,
          webContents: {
            send: (channel, payload) => {
              events.push({ channel, payload });
              if (channel === 'chat:stream:delta' && payload.content === 'first') {
                abortController.abort();
                setTimeout(() => pendingStream?.enqueueNext(), 20);
              }
            },
          },
          streamId: 'responses-abort',
        }),
        { name: 'AbortError' },
      );

      assert.equal(readerCancelled, true);
      assert.deepEqual(
        events
          .filter((event) => event.channel === 'chat:stream:delta')
          .map((event) => event.payload.content),
        ['first'],
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('sends a Gemini stream request and parses text, function calls, and usage', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(sse([
        {
          candidates: [{
            content: {
              parts: [
                { text: 'hello' },
                { functionCall: { name: 'bash', args: { command: 'pwd' } } },
              ],
            },
          }],
        },
        {
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
            cachedContentTokenCount: 3,
          },
        },
      ]), { status: 200 });
    };

    try {
      const result = await sendGeminiStream({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=key',
        headers: { 'Content-Type': 'application/json' },
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        effort: 'off',
        supportsReasoning: false,
        maxOutputTokens: 2048,
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 'g1',
      });

      assert.equal(result.ok, true);
      assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=key');
      assert.equal(captured.body.contents[0].parts[0].text, 'hi');
      assert.equal(captured.body.generationConfig.maxOutputTokens, 2048);
      assert.equal(captured.body.tools[0].functionDeclarations[0].name, 'bash');
      assert.equal(result.content, 'hello');
      assert.equal(result.toolCalls[0].name, 'bash');
      assert.equal(result.toolCalls[0].arguments, '{"command":"pwd"}');
      assert.equal(result.streamUsage.inputTokens, 11);
      assert.equal(result.streamUsage.outputTokens, 7);
      assert.equal(result.streamUsage.cacheReadTokens, 3);
      assert.equal(events.find((event) => event.channel === 'chat:stream:delta').payload.content, 'hello');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('cancels the Gemini SSE reader when the chat stream is aborted', async () => {
    const previousFetch = globalThis.fetch;
    const abortController = new AbortController();
    const events = [];
    let readerCancelled = false;
    let pendingStream = null;

    globalThis.fetch = async () => {
      pendingStream = streamFromChunks([
        sse([{ candidates: [{ content: { parts: [{ text: 'first' }] } }] }]),
        sse([{ candidates: [{ content: { parts: [{ text: 'late' }] } }] }, '[DONE]']),
      ], {
        onCancel: () => {
          readerCancelled = true;
        },
      });
      return new Response(pendingStream.stream, { status: 200 });
    };

    try {
      await assert.rejects(
        sendGeminiStream({
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=key',
          headers: { 'Content-Type': 'application/json' },
          model: 'gemini-test',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          effort: 'off',
          supportsReasoning: false,
          signal: abortController.signal,
          webContents: {
            send: (channel, payload) => {
              events.push({ channel, payload });
              if (channel === 'chat:stream:delta' && payload.content === 'first') {
                abortController.abort();
                setTimeout(() => pendingStream?.enqueueNext(), 20);
              }
            },
          },
          streamId: 'gemini-abort',
        }),
        { name: 'AbortError' },
      );

      assert.equal(readerCancelled, true);
      assert.deepEqual(
        events
          .filter((event) => event.channel === 'chat:stream:delta')
          .map((event) => event.payload.content),
        ['first'],
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
