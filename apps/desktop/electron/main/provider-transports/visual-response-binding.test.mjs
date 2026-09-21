import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDesktopPreviewService, unregisterDesktopPreviewService, registerDesktopPreviewObservation } from '../runtime-gateway/desktop-preview-service.mjs';
import { createVisualRequestReceiptStore } from '../runtime-gateway/visual-request-receipts.mjs';
import { executeDesktopProviderRequest } from '../chat-runtime/provider-request-coordinator.mjs';
import { createVisualRequestScope, consumeVerifiedVisualResponse } from './visual-request-context.mjs';
import { createOpenAIVisualObservationMessage, createAnthropicToolResultContent, createGeminiVisualObservationParts, INDEPENDENT_VISUAL_REVIEW_PURPOSE } from '../chat-runtime/visual-observation-projection.mjs';
import { sanitizeApiMessages } from '../chat-runtime/message-sanitizer.mjs';
import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
import { sendAnthropicMessagesStream } from '../provider-adapters/anthropic-messages-adapter.mjs';
import { sendGeminiStream } from '../provider-adapters/gemini-adapter.mjs';
import { encodedVisualImageHashes, hashVisualBytes } from '../provider-encoders/visual-request-images.mjs';
import { inspectVisualJudgmentCandidate, snapshotVisualResponse } from '../runtime-gateway/visual-judgment-candidate.mjs';

// Real adapters/encoding/parsing/loopback HTTP; fixture sources and judgments are
// NOT production capture or live model/UI acceptance. Do not use user credentials.
const oldTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
process.env.PEER_AGENT_PROVIDER_TRACE = '0';
after(() => { if (oldTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE; else process.env.PEER_AGENT_PROVIDER_TRACE = oldTrace; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=', 'base64');
const adapters = { openai: sendOpenAIChatStream, 'openai-responses': sendOpenAIResponsesStream,
  anthropic: sendAnthropicMessagesStream, gemini: sendGeminiStream };
const finding = 'PRIVATE FIXTURE FINDING, MUST NOT PERSIST';
function candidate(ref, verdict = 'passed') {
  return { kind: 'ui_visual_judgment', version: 1,
    assessments: [{ artifactRef: ref, verdict, findings: [finding], repairSuggestions: ['PRIVATE REPAIR'] }] };
}
function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-response-binding-')));
  const store = {}, streamId = randomUUID(), conversationId = randomUUID();
  const receipts = createVisualRequestReceiptStore({ userDataPath: home });
  const artifactRef = `local-desktop-preview-artifact://${randomUUID()}`;
  const observation = { planId: randomUUID(), conversationId, workspacePath: home, artifactRef,
    artifactHash: hashVisualBytes(png), toolCallId: 'capture', evidenceRef: 'tool-result://capture',
    instanceId: randomUUID(), buildFingerprint: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), requirementRevision: 'c'.repeat(64) };
  let current = true;
  registerDesktopPreviewService(store, home, { requestReceipts: receipts, validateVisualSource() {
    if (!current) throw new Error('fixture-stale'); return observation;
  } });
  const visual = { artifactRef, kind: 'desktop_preview', mediaType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  registerDesktopPreviewObservation(visual, 'capture', { planId: observation.planId, conversationId, workspaceRoot: home, goalPlanStore: store });
  const options = { goalPlanStore: store, workspacePath: home, conversationId, streamId, model: 'local-fixture' };
  t.after(() => { unregisterDesktopPreviewService(store); rmSync(home, { recursive: true, force: true }); });
  return { home, store, visual, observation, options, invalidate() { current = false; },
    records() { return readdirSync(path.join(home, 'ui-delivery/requests')).filter(n => n.endsWith('.json')).map(n => receipts.read(n.slice(0, -5))); } };
}
function messagesFor(f, wire) {
  const result = { output: 'fixture', visualObservations: [f.visual] };
  if (wire === 'anthropic') return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'desktop_preview', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capture', content: createAnthropicToolResultContent(result, INDEPENDENT_VISUAL_REVIEW_PURPOSE) }] },
  ];
  if (wire === 'gemini') return [{ role: 'tool', content: 'fixture', geminiContent: { role: 'user', parts: createGeminiVisualObservationParts([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE) } }];
  return [createOpenAIVisualObservationMessage([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE)];
}
function sse(wire, text, tools = false) {
  const events = wire === 'openai'
    ? [{ choices: [{ delta: { content: text, ...(tools ? { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'observe', arguments: '{}' } }] } : {}) }, finish_reason: tools ? 'tool_calls' : 'stop' }] }]
    : wire === 'openai-responses'
      ? [{ type: 'response.output_text.delta', delta: text }, ...(tools ? [
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'observe', arguments: '{}' } },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'observe', arguments: '{}' } },
      ] : []), { type: 'response.completed', response: { status: 'completed', output: [] } }]
      : wire === 'anthropic'
        ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, ...(tools ? [
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'observe' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        ] : []), { type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }]
        : [{ candidates: [{ content: { role: 'model', parts: [{ text }, ...(tools ? [{ functionCall: { name: 'observe', args: {} } }] : [])] }, finishReason: 'STOP' }] }];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (wire === 'openai' ? 'data: [DONE]\n\n' : '');
}
async function serverFor(t, handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const wire = req.url.slice(1);
    received.push({ body, wire });
    const reply = handler({ wire, body, index: received.length, req, res });
    if (reply === false) return;
    res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' });
    res.end(sse(wire, reply.text, reply.tools));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, received };
}
function send(f, server, wire, messages = messagesFor(f, wire), extra = {}) {
  return adapters[wire]({ baseUrl: server.url, endpoint: `${server.url}/${wire}`, apiKey: 'FAKE-SECRET',
    headers: { 'content-type': 'application/json' }, model: f.options.model, streamId: f.options.streamId,
    messages: sanitizeApiMessages(messages, { toolCallFormat: wire }), tools: [], effort: 'off',
    supportsReasoning: false, webContents: { send() {} }, transientRetryDelaysMs: [], ...extra });
}
function run(f, wire, invoke, signal) {
  return executeDesktopProviderRequest({ request: { messages: messagesFor(f, wire),
    conversationId: f.options.conversationId, streamId: f.options.streamId, signal, contextWindow: 1_000_000,
    providerConfig: { model: f.options.model }, visualRequestHost: { goalPlanStore: f.store, workspacePath: f.home, reviewToken: Object.freeze({}) } },
    buildCanonicalRequest: ({ messages }) => ({ messages }), send: invoke });
}
for (const wire of Object.keys(adapters)) {
  for (const scenario of ['valid-once', 'cloned-response', 'altered-response', 'wrong-review', 'ordinary-chat', 'cancelled', 'stale']) {
    test(`${wire}/${scenario}/one-use-review-proof`, async t => {
      const f = fixture(t); const controller = new AbortController();
      const token = Object.freeze({});
      const server = await serverFor(t, () => ({ text: JSON.stringify(candidate(f.visual.artifactRef)) }));
      const scope = { ...f.options, reviewToken: scenario === 'ordinary-chat' ? undefined : token,
        messages: messagesFor(f, wire), signal: controller.signal };
      if (scenario === 'ordinary-chat') {
        let sent = false;
        assert.throws(() => createVisualRequestScope(scope), /visual-request-review-pending/);
        assert.equal(sent, false);
        assert.equal(server.received.length, 0);
        return;
      }
      const response = await createVisualRequestScope(scope).send(() => send(f, server, wire));
      const consumeScope = { ...f.options, reviewToken: token };
      if (scenario === 'cloned-response') {
        assert.throws(() => consumeVerifiedVisualResponse(structuredClone(response), consumeScope), /unbound/);
      } else if (scenario === 'altered-response') {
        response.content = 'changed'; response.assistantText = 'changed';
        assert.throws(() => consumeVerifiedVisualResponse(response, consumeScope), /changed/);
        assert.throws(() => consumeVerifiedVisualResponse(response, consumeScope), /unbound/);
      } else if (scenario === 'wrong-review') {
        assert.throws(() => consumeVerifiedVisualResponse(response,
          { ...consumeScope, reviewToken: Object.freeze({}) }), /unbound/);
      } else if (scenario === 'cancelled') {
        controller.abort(); assert.throws(() => consumeVerifiedVisualResponse(response, consumeScope), /abort/i);
      } else if (scenario === 'stale') {
        f.invalidate(); assert.throws(() => consumeVerifiedVisualResponse(response, consumeScope), /stale/);
      } else {
        const proof = consumeVerifiedVisualResponse(response, consumeScope);
        assert.equal(proof.candidate.status, 'validated-candidate');
        assert.equal(proof.observations[0].artifactHash, f.observation.artifactHash);
        assert.throws(() => consumeVerifiedVisualResponse(response, consumeScope), /unbound/);
      }
    });
  }
}

function checkPrivate(record) {
  assert.equal(record.version, 2);
  assert.match(record.modelRunId, /^[0-9a-f-]{36}$/);
  assert.equal(record.judgment, 'not-evaluated');
  const text = JSON.stringify(record);
  for (const forbidden of [finding, 'PRIVATE REPAIR', 'FAKE-SECRET', 'base64,', 'admittedToRunId', 'judgments']) assert.ok(!text.includes(forbidden), forbidden);
}

// Section 14 cross-product: each cell uses the actual adapter and final SSE answer.
for (const wire of Object.keys(adapters)) for (const scenario of ['passed', 'failed', 'inconclusive', 'malformed', 'wrong-image', 'tool-response']) {
  test(`${wire}/${scenario}/response-binding`, async t => {
    const f = fixture(t);
    const report = candidate(scenario === 'wrong-image' ? 'unknown' : f.visual.artifactRef,
      ['failed', 'inconclusive'].includes(scenario) ? scenario : 'passed');
    const text = scenario === 'malformed' ? '```json\n' + JSON.stringify(report) + '\n```' : JSON.stringify(report);
    const server = await serverFor(t, () => ({ text, tools: scenario === 'tool-response' }));
    const result = await run(f, wire, c => send(f, server, wire, c.messages));
    assert.equal(result.response.ok, true);
    const [record] = f.records(); checkPrivate(record);
    assert.equal(record.responseBinding.status, 'bound');
    assert.equal(record.responseBinding.wire, wire);
    assert.equal(record.responseBinding.attemptId, record.attempts[0].attemptId);
    assert.equal(record.responseBinding.responseHash, snapshotVisualResponse(result.response, wire).responseHash);
    assert.ok(encodedVisualImageHashes(server.received[0].body, wire).has(f.observation.artifactHash));
    const expected = scenario === 'tool-response' ? 'tool-response' : ['malformed', 'wrong-image'].includes(scenario) ? 'invalid' : 'validated-candidate';
    assert.equal(record.responseBinding.candidate.status, expected);
    if (expected === 'validated-candidate') {
      assert.equal(record.responseBinding.candidate.assessments[0].verdict, scenario);
      assert.equal(record.responseBinding.candidate.assessments[0].artifactHash, f.observation.artifactHash);
      assert.equal(record.responseBinding.candidate.assessments[0].findingsHash, hashVisualBytes(JSON.stringify([finding])));
    }
  });
}

for (const wire of Object.keys(adapters)) for (const fault of ['clone', 'mutate', 'earlier', 'cross-send', 'missing-image', 'http-error', 'cancel', 'stale']) {
  test(`${wire}/${fault}/no-bound-candidate`, async t => {
    const f = fixture(t), controller = new AbortController();
    const server = await serverFor(t, () => {
      if (fault === 'cancel') { controller.abort(); return false; }
      if (fault === 'stale') f.invalidate();
      return { text: JSON.stringify(candidate(f.visual.artifactRef)), status: fault === 'http-error' ? 400 : 200 };
    });
    let oldResponse;
    if (fault === 'cross-send') oldResponse = (await run(f, wire, c => send(f, server, wire, c.messages))).response;
    const previousIds = new Set(fault === 'cross-send' ? f.records().map(r => r.requestId) : []);
    const result = run(f, wire, async c => {
      const response = await send(f, server, wire, fault === 'missing-image' ? [{ role: 'user', content: 'no image' }] : c.messages,
        { signal: controller.signal });
      if (fault === 'clone') return structuredClone(response);
      if (fault === 'mutate') response[wire === 'anthropic' ? 'textContent' : 'content'] += ' ';
      if (fault === 'earlier') { await send(f, server, wire, c.messages); return response; }
      return fault === 'cross-send' ? oldResponse : response;
    }, controller.signal);
    if (['cancel', 'stale'].includes(fault)) await assert.rejects(result); else await result;
    const record = f.records().find(r => !previousIds.has(r.requestId)); checkPrivate(record);
    assert.equal(record.responseBinding.status, 'unbound');
    assert.equal(record.responseBinding.candidate, undefined);
    if (fault === 'earlier') assert.equal(record.responseBinding.reason, 'attempt-mismatch');
    if (fault === 'mutate') assert.equal(record.responseBinding.reason, 'response-changed');
    if (fault === 'cross-send') assert.equal(new Set(f.records().map(r => r.modelRunId)).size, 2);
  });
}

test('concurrent-sends-and-nested-sends-keep-response-ownership', async t => {
  const f = fixture(t), g = fixture(t);
  const server = await serverFor(t, () => ({ text: 'ordinary response' }));
  await Promise.all([f, g].map(value => run(value, 'openai', c => send(value, server, 'openai', c.messages))));
  assert.equal(f.records()[0].responseBinding.status, 'bound');
  assert.equal(g.records()[0].responseBinding.status, 'bound');
  assert.notEqual(f.records()[0].modelRunId, g.records()[0].modelRunId);
  const previousIds = new Set(f.records().map(r => r.requestId));
  await run(f, 'openai', () => createVisualRequestScope({ messages: [] }).send(() => send(f, server, 'openai')));
  const record = f.records().find(r => !previousIds.has(r.requestId));
  assert.equal(record.responseBinding.status, 'unbound');
  assert.equal(record.attempts.length, 0);
});

test('Responses adapter retry binds only final attempt', async t => {
  const f = fixture(t);
  const server = await serverFor(t, ({ index }) => ({ status: index === 1 ? 503 : 200, text: JSON.stringify(candidate(f.visual.artifactRef)) }));
  await run(f, 'openai-responses', c => send(f, server, 'openai-responses', c.messages, { transientRetryDelaysMs: [0] }));
  const [record] = f.records();
  assert.equal(record.responseBinding.status, 'bound');
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[0].status, 'http-error');
  assert.equal(record.responseBinding.attemptId, record.attempts[1].attemptId);
});

for (const wire of Object.keys(adapters)) test(`${wire}/overflow-rebuild-does-not-bind-removed-image`, async t => {
  const f = fixture(t);
  const server = await serverFor(t, ({ index }) => ({ status: index === 1 ? 400 : 200,
    text: index === 1 ? "This model's maximum prompt length is 1000000 but the request contains 1000100 tokens."
      : JSON.stringify(candidate(f.visual.artifactRef)) }));
  const result = await executeDesktopProviderRequest({ request: { messages: messagesFor(f, wire),
    conversationId: f.options.conversationId, streamId: f.options.streamId, contextWindow: 1_000_000,
    providerConfig: { model: f.options.model }, visualRequestHost: { goalPlanStore: f.store, workspacePath: f.home, reviewToken: Object.freeze({}) } },
    buildCanonicalRequest: ({ messages }) => ({ messages }),
    compactRequest: async () => ({ compacted: true, messages: [{ role: 'user', content: 'compacted without image' }] }),
    send: c => send(f, server, wire, c.messages) });
  assert.equal(result.retriedAfterOverflow, true);
  assert.equal(f.records().length, 2);
  for (const record of f.records()) assert.equal(record.responseBinding.status, 'unbound');
  assert.equal(new Set(f.records().map(r => r.modelRunId)).size, 2);
});

test('concurrent-adapters-in-one-send-do-not-share-attempts', async t => {
  const f = fixture(t);
  const server = await serverFor(t, () => ({ text: JSON.stringify(candidate(f.visual.artifactRef)) }));
  await run(f, 'openai', async c => {
    const [first] = await Promise.all([send(f, server, 'openai', c.messages), send(f, server, 'openai', c.messages)]);
    return first;
  });
  const [record] = f.records();
  assert.equal(record.attempts.length, 2);
  assert.equal(record.responseBinding.status, 'unbound');
  assert.equal(record.responseBinding.reason, 'attempt-mismatch');
});

for (const wire of Object.keys(adapters)) test(`${wire}/cancel-after-adapter-return-revokes-binding`, async t => {
  const f = fixture(t), controller = new AbortController();
  const server = await serverFor(t, () => ({ text: JSON.stringify(candidate(f.visual.artifactRef)) }));
  await assert.rejects(run(f, wire, async c => {
    const response = await send(f, server, wire, c.messages);
    controller.abort(); return response;
  }, controller.signal));
  const [record] = f.records();
  assert.equal(record.status, 'cancelled');
  assert.equal(record.responseBinding.status, 'unbound');
});

test('untracked-send-cannot-mint-bound-candidate', async t => {
  const f = fixture(t);
  await run(f, 'openai', async () => ({ ok: true, content: JSON.stringify(candidate(f.visual.artifactRef)) }));
  const [record] = f.records();
  assert.equal(record.responseBinding.status, 'unbound');
  assert.equal(record.responseBinding.candidate, undefined);
});

for (const fault of ['version', 'extra-id', 'extra-field', 'unknown-verdict', 'empty-findings', 'oversized-finding', 'too-many-findings', 'nonstring', 'duplicate-ref', 'missing-ref', 'empty', 'oversized-response']) {
  test(`candidate/${fault}`, () => {
    const ref = 'local-desktop-preview-artifact://fixture';
    const report = candidate(ref);
    if (fault === 'version') report.version = 2;
    if (fault === 'extra-id') report.modelRunId = 'model-forged';
    if (fault === 'extra-field') report.assessments[0].instanceId = 'model-forged';
    if (fault === 'unknown-verdict') report.assessments[0].verdict = 'accepted';
    if (fault === 'empty-findings') report.assessments[0].findings = [];
    if (fault === 'oversized-finding') report.assessments[0].findings = ['x'.repeat(2001)];
    if (fault === 'too-many-findings') report.assessments[0].findings = Array(21).fill('x');
    if (fault === 'nonstring') report.assessments[0].findings = [{ text: 'x' }];
    if (fault === 'duplicate-ref') report.assessments.push(report.assessments[0]);
    if (fault === 'missing-ref') report.assessments = [];
    const text = fault === 'empty' ? '' : fault === 'oversized-response' ? ' '.repeat(65537) + '{}' : JSON.stringify(report);
    const result = inspectVisualJudgmentCandidate({ text, hasTools: false }, [{ artifactRef: ref, artifactHash: 'hash' }]);
    assert.notEqual(result.status, 'validated-candidate');
  });
}

test('candidate/multiple-observations-require-exact-coverage', () => {
  const a = candidate('a'), b = candidate('b', 'inconclusive');
  const observations = [{ artifactRef: 'a', artifactHash: '1' }, { artifactRef: 'b', artifactHash: '2' }];
  a.assessments.push(b.assessments[0]);
  assert.equal(inspectVisualJudgmentCandidate({ text: JSON.stringify(a) }, observations).status, 'validated-candidate');
  a.assessments[1] = a.assessments[0];
  assert.equal(inspectVisualJudgmentCandidate({ text: JSON.stringify(a) }, observations).status, 'invalid');
});
