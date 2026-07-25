import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextCountCapabilityForProvider,
  countAnthropicCanonicalRequest,
  countGeminiCanonicalRequest,
} from './context-count-adapter.mjs';

test('Anthropic count uses the canonical encoder and retains tools/cache blocks', async () => {
  let captured;
  const result = await countAnthropicCanonicalRequest({
    baseUrl: 'https://anthropic.example',
    apiKey: 'secret',
    model: 'claude-test',
    system: 'system prompt',
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: 'result' },
    ],
    tools: [{
      name: 'lookup',
      description: 'Lookup',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }],
    promptCaching: true,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ input_tokens: 498_138 }), { status: 200 });
    },
  });

  assert.equal(captured.url, 'https://anthropic.example/v1/messages/count_tokens');
  assert.equal(captured.body.stream, undefined);
  assert.equal(captured.body.max_tokens, undefined);
  assert.equal(captured.body.messages[1].content[0].type, 'tool_use');
  assert.equal(captured.body.messages[2].content[0].type, 'tool_result');
  assert.ok(Array.isArray(captured.body.system));
  assert.deepEqual(result, { inputTokens: 498_138, source: 'provider_count_api' });
});

test('Gemini count wraps the same generate-content shape including tools and system', async () => {
  let captured;
  const result = await countGeminiCanonicalRequest({
    baseUrl: 'https://generativelanguage.example/v1beta',
    apiKey: 'secret',
    model: 'gemini-test',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup',
        parameters: { type: 'object', properties: {} },
      },
    }],
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ totalTokens: 501_244 }), { status: 200 });
    },
  });

  assert.equal(
    captured.url,
    'https://generativelanguage.example/v1beta/models/gemini-test:countTokens?key=secret',
  );
  assert.equal(captured.body.generateContentRequest.model, 'models/gemini-test');
  assert.equal(
    captured.body.generateContentRequest.systemInstruction.parts[0].text,
    'system prompt',
  );
  assert.equal(
    captured.body.generateContentRequest.tools[0].functionDeclarations[0].name,
    'lookup',
  );
  assert.deepEqual(result, { inputTokens: 501_244, source: 'provider_count_api' });
});

test('provider capabilities explicitly distinguish exact and observed-only paths', () => {
  assert.deepEqual(
    contextCountCapabilityForProvider({ provider: 'anthropic' }),
    { kind: 'provider_count_api' },
  );
  assert.deepEqual(
    contextCountCapabilityForProvider({ provider: 'gemini', authMethod: 'api_key' }),
    { kind: 'provider_count_api' },
  );
  assert.deepEqual(
    contextCountCapabilityForProvider({ provider: 'gemini', authMethod: 'oauth_google' }),
    { kind: 'observed_usage_only' },
  );
  assert.deepEqual(
    contextCountCapabilityForProvider({ provider: 'openai' }),
    { kind: 'observed_usage_only' },
  );
});
