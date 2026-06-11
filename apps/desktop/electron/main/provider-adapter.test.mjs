import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
import { sendOpenAIChatStream } from './provider-adapters/openai-chat-adapter.mjs';

function sse(frames) {
  return frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
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
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's1',
      });

      assert.equal(captured.url, 'https://example.test/v1/chat/completions');
      assert.equal(captured.init.headers.Authorization, 'Bearer key');
      assert.equal(captured.body.model, 'gpt-test');
      assert.equal(captured.body.reasoning_effort, 'high');
      assert.equal(result.ok, true);
      assert.equal(result.content, 'hello');
      assert.equal(result.toolCalls[0].name, 'bash');
      assert.equal(result.toolCalls[0].arguments, '{"command":"pwd"}');
      assert.equal(result.streamUsage.inputTokens, 10);
      assert.equal(events.find((event) => event.channel === 'chat:stream:delta').payload.content, 'hello');
      assert.equal(events.find((event) => event.channel === 'chat:stream:usage').payload.usage.cacheReadTokens, 3);
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
        webContents: { send: (channel, payload) => events.push({ channel, payload }) },
        streamId: 's1',
      });

      assert.equal(captured.url, 'https://example.test/v1/messages');
      assert.equal(captured.init.headers['x-api-key'], 'key');
      assert.ok(Array.isArray(captured.body.system));
      assert.equal(captured.body.system[0].text, 'system');
      assert.equal(captured.body.system[0].cache_control.type, 'ephemeral');
      assert.equal(captured.body.thinking.type, 'enabled');
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
});
