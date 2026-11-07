import assert from 'node:assert/strict';
import test from 'node:test';
import { isPromptTooLongError, parseContextOverflowEvidence } from '@peer-agent/runtime-core';

import type { ModelStreamEvent } from './model-provider-contracts.ts';
import {
  createOpenAICompatibleProvider,
  encodeOpenAICompatibleRequest,
  ModelProviderHttpError,
  ModelProviderStreamError,
} from './openai-compatible-provider.ts';

const encoder = new TextEncoder();

function sseResponse(records: readonly string[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const record of records) controller.enqueue(encoder.encode(`data: ${record}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function provider(fetchImplementation: typeof fetch) {
  return createOpenAICompatibleProvider({
    config: {
      providerId: 'openai',
      apiKey: 'secret-key',
      baseUrl: 'https://example.test/v1/',
      organizationId: 'org-1',
      headers: { 'X-Custom': 'yes' },
    },
    fetch: fetchImplementation,
  });
}

test('streams text and usage without exposing credentials in the result', async () => {
  const events: ModelStreamEvent[] = [];
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const model = provider(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      '[DONE]',
    ]);
  });

  const result = await model.stream({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'Hi' }],
    onEvent: (event) => events.push(event),
  });

  assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
  assert.equal(new Headers(capturedInit?.headers).get('Authorization'), 'Bearer secret-key');
  assert.equal(new Headers(capturedInit?.headers).get('OpenAI-Organization'), 'org-1');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: 'gpt-test', messages: [{ role: 'user', content: 'Hi' }], stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(result, {
    content: 'Hello', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
  assert.deepEqual(events.map((event) => event.type), ['text.delta', 'text.delta', 'usage']);
  assert.doesNotMatch(JSON.stringify(result), /secret-key/);
});

test('encodes explicit reasoning effort without overriding provider defaults', async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = provider(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse(['[DONE]']);
  });

  await model.stream({ model: 'gpt-test', messages: [], reasoningEffort: 'high' });
  await model.stream({ model: 'gpt-test', messages: [], reasoningEffort: 'default' });

  assert.equal(bodies[0]?.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in (bodies[1] ?? {}), false);
});

test('tool history is paired by call id without unsupported message-level names', async () => {
  let body: any;
  const model = provider(async (_input, init) => { body = JSON.parse(String(init?.body)); return sseResponse(['[DONE]']); });
  await model.stream({model:'glm-5.3-flash',messages:[
    {role:'assistant',content:null,toolCalls:[{id:'read-1',name:'read_file',arguments:'{}'}]},
    {role:'tool',name:'read_file',toolCallId:'read-1',content:'real output'},
  ]});
  assert.equal(body.messages[1].name, undefined);
  assert.equal(body.messages[1].tool_call_id, 'read-1');
  assert.equal(body.messages[0].tool_calls[0].function.name, 'read_file');
});

test('assembles streamed tool calls and serializes tools', async () => {
  const events: ModelStreamEvent[] = [];
  let body: Record<string, unknown> = {};
  const model = provider(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"pa' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] } }] }),
      '[DONE]',
    ]);
  });

  const result = await model.stream({
    model: 'gpt-test', messages: [],
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }]);
  assert.equal(events.at(-1)?.type, 'tool_call.completed');
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }]);
});

test('passes AbortSignal to fetch and preserves cancellation', async () => {
  const controller = new AbortController();
  const model = provider(async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(new DOMException('Cancelled', 'AbortError'));
    });
  });
  await assert.rejects(model.stream({ model: 'gpt-test', messages: [], signal: controller.signal }), { name: 'AbortError' });
});

test('returns typed HTTP and malformed SSE errors without credentials', async () => {
  const httpModel = provider(async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }));
  await assert.rejects(httpModel.stream({ model: 'gpt-test', messages: [] }), (error: unknown) => {
    assert.ok(error instanceof ModelProviderHttpError);
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });

  const streamModel = provider(async () => sseResponse(['not-json']));
  await assert.rejects(streamModel.stream({ model: 'gpt-test', messages: [] }), ModelProviderStreamError);
});

test('preserves gateway string errors and bounded budget facts', async () => {
  const model = createOpenAICompatibleProvider({
    config: { providerId: 'company', apiKey: 'secret-key', baseUrl: 'https://example.test/v1' },
    trustGatewayErrors: true,
    fetch: async () => new Response(JSON.stringify({ error: 'Invalid Peer model request', code: 'peer_request_messages_exceeded', source: 'gateway_validation', details: { actual: 515, limit: 512, upstream_attempted: false } }), { status: 400 }),
  });
  await assert.rejects(model.stream({ model: 'fixture', messages: [] }), (error: any) => {
    assert.equal(error.diagnostic?.code, 'peer_request_messages_exceeded');
    assert.equal(error.diagnostic?.actual, 515);
    assert.match(error.message, /515.*512/);
    return true;
  });
});

test('preflight encoding equals the actual wire including UTF-8 and tools', async () => {
  const input = { model: 'fixture', messages: [{ role: 'user' as const, content: '中文 body' }], tools: [{ name: 'read_file', parameters: { type: 'object' } }], maxOutputTokens: 4096, reasoningEffort: 'high' as const };
  const body = encodeOpenAICompatibleRequest(input);
  const model = provider(async (_url, request) => { assert.equal(request?.body, body); assert.equal(Buffer.byteLength(body), new TextEncoder().encode(String(request?.body)).length); return sseResponse(['[DONE]']); });
  await model.stream(input);
});

test('legacy three-argument errors retain safe overflow categories and provider token facts', () => {
  for (const detail of [
    JSON.stringify({error:{code:'context_length_exceeded',message:'PRIVATE_ECHO'}}),
    'Maximum context length exceeded: PRIVATE_ECHO',
    `data: ${JSON.stringify({error:{type:'invalid_request_error',message:"This model's maximum prompt length is 1000 but the request contains 1200 tokens. PRIVATE_ECHO"}})}\n\n`,
  ]) {
    const error = new ModelProviderHttpError('legacy', 400, detail);
    assert.equal(error.diagnostic.code, 'context_length_exceeded');
    assert.match(error.message, /context_length_exceeded/);
    assert.doesNotMatch(error.message, /PRIVATE_ECHO/);
    assert.equal(error.status, 400);
    assert.equal(isPromptTooLongError(error.status, error.message), true);
    if (detail.startsWith('data:')) {
      const evidence = parseContextOverflowEvidence({status:400,message:error.message});
      assert.ok(evidence);
      assert.equal(evidence.maximumTokens,1000);
      assert.equal(evidence.requestedTokens,1200);
    }
  }
});

test('legacy detail cannot invent trusted origins or leak arbitrary content', () => {
  for (const detail of [
    'PRIVATE_ECHO', '<html>context_length_exceeded PRIVATE_ECHO</html>',
    'constructor', 'toString', 'context_length_exceeded'.repeat(4000),
    JSON.stringify({code:'peer_request_messages_exceeded',source:'gateway_validation',details:{actual:515,limit:512,upstream_attempted:false}}),
    JSON.stringify({error:{code:'1261',message:'PRIVATE_ECHO'}}),
  ]) {
    const error = new ModelProviderHttpError('legacy',400,detail);
    assert.equal(error.message, 'Model provider "legacy" returned HTTP 400.');
    assert.equal(error.diagnostic.code,'http_error');
    assert.equal(error.diagnostic.source,'provider');
    assert.equal(error.diagnostic.upstreamAttempted,undefined);
  }
  const explicit = new ModelProviderHttpError('legacy',401,'context_length_exceeded',{status:401,source:'provider',code:'authentication_error'});
  assert.equal(explicit.diagnostic.code,'authentication_error');
  assert.doesNotMatch(explicit.message,/context_length/);
});

test('legacy constructor shares the complete established core overflow vocabulary', () => {
  for (const message of ['prompt_too_long','context_length_exceeded','maximum context length exceeded',
    'maximum prompt length exceeded','context window is full','context too long',
    'input is too long for this model','exceeds model context window','too many tokens','token limit exceeded']) {
    const error = new ModelProviderHttpError('legacy',400,JSON.stringify({error:{message:message+': PRIVATE_ECHO'}}));
    assert.equal(isPromptTooLongError(error.status,error.message),true,message);
    assert.equal(error.diagnostic.code,'context_length_exceeded');
    assert.doesNotMatch(error.message,/PRIVATE_ECHO/);
  }
});
