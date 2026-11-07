import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderHttpError } from './provider-http-error.mjs';
import { parseContextOverflowEvidence } from '@peer-agent/runtime-core';
for (const payload of [
  { error: { code: 'context_length_exceeded', message: 'secret-key PROMPT_ECHO' } },
  { code: 'context_length_exceeded', error: 'secret-key PROMPT_ECHO' },
  { message: 'maximum context length exceeded: secret-key PROMPT_ECHO' },
  { error: { type: 'invalid_request_error', message: 'Maximum context length exceeded: secret-key PROMPT_ECHO' } },
])
  test(`safe diagnostic for ${JSON.stringify(payload).slice(0, 40)}`, async () => {
    const result = await readProviderHttpError(new Response(JSON.stringify(payload), { status: 400 }), { secrets: ['secret-key'] });
    assert.equal(result.diagnostic.code, 'context_length_exceeded');
    assert.doesNotMatch(JSON.stringify(result), /secret-key|PROMPT_ECHO/);
  });
for (const text of ['', '<html>secret-key PROMPT_ECHO</html>', 'arbitrary secret-key PROMPT_ECHO', 'x'.repeat(70000)])
  test(`omits unsafe error body (${text.length} bytes)`, async () => {
    const result = await readProviderHttpError(new Response(text, { status: 503 }));
    assert.equal(result.diagnostic.status, 503);
    assert.equal(result.detail, undefined);
    assert.doesNotMatch(JSON.stringify(result), /secret-key|PROMPT_ECHO|xxx|html/);
  });
test('gateway-shaped provider text cannot claim an unattempted platform rejection', async () => {
  const result = await readProviderHttpError(new Response(JSON.stringify({ source: 'gateway_validation', code: 'peer_request_messages_exceeded', details: { actual: 515, limit: 512, upstream_attempted: false } }), { status: 400 }));
  assert.equal(result.diagnostic.source, 'provider');
  assert.equal(result.diagnostic.upstreamAttempted, undefined);
});
test('stalled error body is bounded and cancelled', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 400 });
  const result = await readProviderHttpError(response, { timeoutMs: 10 });
  assert.equal(result.diagnostic.code, 'http_error');
  assert.equal(cancelled, true);
});
test('error-body cancellation remains cancellation', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream(), { status: 400 });
  const pending = readProviderHttpError(response, { signal: controller.signal });
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('empty HTTP failures retain a safe correlation header', async()=>{
 const result=await readProviderHttpError(new Response('',{status:400,headers:{'x-request-id':'12345678-abcd-1234-abcd-123456789abc'}}));
 assert.equal(result.diagnostic.requestId,'12345678-abcd-1234-abcd-123456789abc');
});

test('legacy string-shaped gateway errors retain a safe category', async()=>{
 const invalid=await readProviderHttpError(new Response('{"error":"Invalid Peer model request"}',{status:400}));
 assert.equal(invalid.diagnostic.code,'invalid_request_error');assert.match(invalid.detail,/Invalid request/);
 const missing=await readProviderHttpError(new Response('{"error":"Configure a workspace model credential in Settings"}',{status:503}));
 assert.equal(missing.diagnostic.code,'configuration_error');
});

test('generic invalid request without a context assertion stays generic', async () => {
  const result = await readProviderHttpError(new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Invalid tools schema' } }), { status: 400 }));
  assert.equal(result.diagnostic.code, 'invalid_request_error');
});

for (const [host, code, expected] of [
  ['open.bigmodel.cn', '1113', 'insufficient_quota'],
  ['open.bigmodel.cn', '1261', 'context_length_exceeded'],
  ['unrelated.invalid', '1113', 'http_error'],
  ['open.bigmodel.cn', 'constructor', 'http_error'],
]) test(`numeric ${code} is scoped to the recognized upstream ${host}`, async () => {
  const response = new Response(JSON.stringify({error:{code,message:'PRIVATE_ECHO'}}),{status:429});
  Object.defineProperty(response,'url',{value:`https://${host}/api/paas/v4/chat/completions`});
  const result=await readProviderHttpError(response);
  assert.equal(result.diagnostic.code,expected);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ECHO/);
});

test('the known maximum-prompt assertion retains the shared overflow marker without echoing its body', async () => {
  const response = new Response("This model's maximum prompt length is 1000000 but the request contains 1000100 tokens. PRIVATE_ECHO", {status:400});
  const result = await readProviderHttpError(response);
  assert.equal(result.diagnostic.code, 'context_length_exceeded');
  assert.match(result.detail, /context_length_exceeded/);
  const evidence = parseContextOverflowEvidence({status:400,message:result.detail});
  assert.equal(evidence.maximumTokens,1000000);
  assert.equal(evidence.requestedTokens,1000100);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ECHO/);
});

test('HTTP-error SSE keeps only a recognized overflow assertion', async () => {
  const content = "This model's maximum prompt length is 1000000 but the request contains 1000100 tokens. PRIVATE_ECHO";
  const body = `data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`;
  const result = await readProviderHttpError(new Response(body,{status:400}));
  assert.equal(result.diagnostic.code, 'context_length_exceeded');
  assert.match(result.detail, /context_length_exceeded/);
  const evidence = parseContextOverflowEvidence({status:400,message:result.detail});
  assert.equal(evidence.maximumTokens,1000000);
  assert.equal(evidence.requestedTokens,1000100);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ECHO/);
  const unknown = await readProviderHttpError(new Response('data: {"choices":[{"delta":{"content":"PRIVATE_ECHO"}}]}\n\n',{status:400}));
  assert.equal(unknown.diagnostic.code,'http_error');
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_ECHO/);
});

const supportedOverflowMessages = [
  'prompt_too_long', 'context_length_exceeded', 'maximum context length exceeded',
  'maximum prompt length exceeded', 'context window is full', 'context too long',
  'input is too long for this model', 'exceeds model context window',
  'too many tokens', 'token limit exceeded',
];
for (const message of supportedOverflowMessages) test(`retains existing core overflow spelling: ${message}`, async () => {
  for (const raw of [message + ': PRIVATE_ECHO', JSON.stringify({error:{type:'invalid_request_error',message:message + ': PRIVATE_ECHO'}})]) {
    const result = await readProviderHttpError(new Response(raw,{status:400}));
    assert.equal(result.diagnostic.code,'context_length_exceeded');
    assert.match(result.detail,/context_length_exceeded/);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ECHO/);
  }
});

for (const [message, requestedTokens, maximumTokens] of [
  ['maximum context length of 1000 tokens; requested 1200 tokens PRIVATE_ECHO',1200,1000],
  ['input is too long; requested 1200 tokens PRIVATE_ECHO',1200,undefined],
  ['maximum context length is 1000 PRIVATE_ECHO',undefined,1000],
]) test(`retains existing partial token evidence: ${requestedTokens}/${maximumTokens}`, async () => {
  const result = await readProviderHttpError(new Response(JSON.stringify({error:{message}}),{status:400}));
  const evidence = parseContextOverflowEvidence({status:400,message:result.detail});
  assert.ok(evidence);
  assert.equal(evidence.requestedTokens,requestedTokens);
  assert.equal(evidence.maximumTokens,maximumTokens);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ECHO/);
});
