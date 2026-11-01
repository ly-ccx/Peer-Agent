import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProviderTextInference } from '@peer-agent/runtime-node/models';

const text = JSON.stringify({ kind: 'next_turn', text: '检查一下过渡。' });
const frames = values => new Response(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const fixtures = {
  'openai-chat': () => frames([{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }, '[DONE]']),
  'anthropic-messages': () => frames([{ type: 'message_start', message: { usage: { input_tokens: 20 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' }]),
  gemini: () => frames([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } }]),
  'openai-responses': () => frames([{ type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 10 } } }]),
};

for (const wire of Object.keys(fixtures)) test(`${wire}: pure inference uses real encoder/consumer, empty tools and callback usage without a window`, async () => {
  let body, calls = 0;
  const usage = [];
  const infer = createProviderTextInference({ resolveCredential: async () => ({ apiKey: 'fixture-key' }),
    resolveChannel: () => ({ wire, baseUrl: 'http://127.0.0.1', endpoint: 'http://127.0.0.1/infer', headers: {} }),
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); calls++; return fixtures[wire](); } });
  const result = await infer({ route: { provider: { id: 'fixture', model: 'fast' } },
    messages: [{ role: 'system', content: 'input aid' }, { role: 'user', content: 'unsent-private-draft' }],
    signal: new AbortController().signal, maxOutputTokens: 128, onUsage: value => usage.push(value) });
  assert.equal(result.ok, true); assert.equal(result.content, text); assert.equal(result.toolCalls.length, 0);
  assert.ok(!body.tools || body.tools.length === 0); assert.equal(calls, 1); assert.ok(usage.length > 0);
});

test('prediction transport never writes provider traces, even on echoed HTTP errors with tracing forced on', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'peer-prediction-private-'));
  const oldHome = process.env.PEER_AGENT_HOME, oldTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
  process.env.PEER_AGENT_HOME = directory; process.env.PEER_AGENT_PROVIDER_TRACE = '1';
  t.after(() => { if (oldHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = oldHome;
    if (oldTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE; else process.env.PEER_AGENT_PROVIDER_TRACE = oldTrace;
    rmSync(directory, { recursive: true, force: true }); });
  for (const wire of Object.keys(fixtures)) {
    const infer = createProviderTextInference({ resolveCredential: async () => ({ apiKey: 'secret' }),
      resolveChannel: () => ({ wire, baseUrl: 'http://127.0.0.1', endpoint: 'http://127.0.0.1/infer', headers: {} }),
      fetchImpl: async () => new Response('echoed-unsent-private-draft', { status: 500 }) });
    const result = await infer({ route: { provider: { id: 'p', model: 'm' } }, messages: [{ role: 'user', content: 'unsent-private-draft' }],
      signal: new AbortController().signal, maxOutputTokens: 128 });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /unsent-private-draft/);
  }
  assert.deepEqual(readdirSync(directory), []);
});
