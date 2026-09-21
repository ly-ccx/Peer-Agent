import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDesktopPreviewService, unregisterDesktopPreviewService,
  registerDesktopPreviewObservation, collectProjectedPreviewObservations } from '../runtime-gateway/desktop-preview-service.mjs';
import { createVisualRequestReceiptStore } from '../runtime-gateway/visual-request-receipts.mjs';
import { createVisualRequestScope } from './visual-request-context.mjs';
import { fetchWithConnectionRecovery } from './recovering-fetch.mjs';
import { executeDesktopProviderRequest } from '../chat-runtime/provider-request-coordinator.mjs';
import { sanitizeApiMessages } from '../chat-runtime/message-sanitizer.mjs';
import { createOpenAIVisualObservationMessage, createAnthropicToolResultContent,
  createGeminiVisualObservationParts, INDEPENDENT_VISUAL_REVIEW_PURPOSE } from '../chat-runtime/visual-observation-projection.mjs';
import { encodeOpenAIChatRequest, encodeOpenAIResponsesRequest, encodeAnthropicMessagesRequest,
  encodeGeminiGenerateContentRequest } from '../provider-encoders/index.mjs';
import { encodedVisualImageHashes, hashVisualBytes } from '../provider-encoders/visual-request-images.mjs';

// Fixture provenance only. The Electron smoke, not these fixture registrations,
// proves production capture/index validation. The HTTP server is NOT a model.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=', 'base64');
const wires = ['openai', 'openai-responses', 'anthropic', 'gemini'];
const encoders = { openai: encodeOpenAIChatRequest, 'openai-responses': encodeOpenAIResponsesRequest,
  anthropic: encodeAnthropicMessagesRequest, gemini: encodeGeminiGenerateContentRequest };
function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-visual-request-test-')));
  const store = {};
  const requestReceipts = createVisualRequestReceiptStore({ userDataPath: home });
  let current = true;
  const metadata = { planId: randomUUID(), conversationId: randomUUID(), workspacePath: home,
    artifactRef: `local-desktop-preview-artifact://${randomUUID()}`, artifactHash: hashVisualBytes(png),
    evidenceRef: 'tool-result://capture', toolCallId: 'capture', instanceId: randomUUID(),
    buildFingerprint: 'b'.repeat(64), sourceFingerprint: 'a'.repeat(64), requirementRevision: 'c'.repeat(64),
    prompt: 'MUST-NOT-PERSIST', dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  const provider = { requestReceipts, validateVisualSource() {
    if (!current) throw new Error('fixture-source-stale');
    return metadata;
  } };
  registerDesktopPreviewService(store, home, provider);
  const visual = { kind: 'desktop_preview', mediaType: 'image/png', artifactRef: metadata.artifactRef,
    dataUrl: metadata.dataUrl };
  const source = { planId: metadata.planId, conversationId: metadata.conversationId,
    workspaceRoot: home, goalPlanStore: store };
  registerDesktopPreviewObservation(visual, 'capture', source);
  const options = { goalPlanStore: store, workspacePath: home, conversationId: metadata.conversationId,
    streamId: randomUUID(), model: 'fixture-model', reviewToken: Object.freeze({}) };
  t.after(() => { unregisterDesktopPreviewService(store); rmSync(home, { recursive: true, force: true }); });
  const receipts = () => {
    let files;
    try { files = readdirSync(path.join(home, 'ui-delivery/requests')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(file => file.endsWith('.json')).map(file => requestReceipts.read(file.slice(0, -5)));
  };
  return { home, store, options, visual, source, metadata, provider, receipts,
    invalidate() { current = false; } };
}
function messagesFor(wire, visual) {
  const result = { output: 'fixture tool result', visualObservations: [visual] };
  if (wire === 'anthropic') return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'desktop_preview', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capture', content: createAnthropicToolResultContent(result, INDEPENDENT_VISUAL_REVIEW_PURPOSE) }] },
  ];
  if (wire === 'gemini') return [{ role: 'tool', content: 'fixture tool result', geminiContent: {
    role: 'user', parts: createGeminiVisualObservationParts([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE),
  } }];
  return [createOpenAIVisualObservationMessage([{ result }], INDEPENDENT_VISUAL_REVIEW_PURPOSE)];
}
function encode(wire, messages, extra = {}) {
  return JSON.stringify(encoders[wire]({ model: 'fixture-model', messages: sanitizeApiMessages(messages, { toolCallFormat: wire }),
    tools: [], effort: 'off', promptCaching: false, ...extra }));
}
async function endpoint(t, handler = () => ({})) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ body, authorization: req.headers.authorization });
    const result = await handler({ req, res, body, attempt: received.length });
    if (result === false) return;
    res.writeHead(result?.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result?.payload ?? { fixture: 'local-transport-only' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/fixture?secret=DO-NOT-RECORD`, received };
}
async function transport(f, wire, url, body, { signal, retry = false, buildInit, model, streamId } = {}) {
  const response = await fetchWithConnectionRecovery(url, { method: 'POST', body, signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer FAKE-TEST-SECRET' } }, {
    provider: wire, model: model ?? f.options.model, streamId: streamId ?? f.options.streamId,
    requireElectronTransport: false, connectTimeoutMs: 0, retryDelaysMs: retry ? [0] : [], buildInit,
  });
  const payload = await response.json();
  return { ok: response.ok, status: response.status, streamError: payload.streamError, content: 'fixture response' };
}
async function coordinated(f, wire, messages, send, extra = {}) {
  return executeDesktopProviderRequest({ request: { messages, systemPrompt: '', contextWindow: 1_000_000,
    conversationId: f.options.conversationId, streamId: f.options.streamId,
    providerConfig: { model: f.options.model }, signal: extra.signal,
    visualRequestHost: { goalPlanStore: f.store, workspacePath: f.home, reviewToken: f.options.reviewToken } },
    buildCanonicalRequest: ({ messages: projected }) => ({ messages: sanitizeApiMessages(projected, { toolCallFormat: wire }) }),
    send, ...extra });
}
function assertReceiptPrivacy(record) {
  const text = JSON.stringify(record);
  for (const value of ['MUST-NOT-PERSIST', 'FAKE-TEST-SECRET', 'DO-NOT-RECORD', png.toString('base64'),
    'fixture response', 'admittedToRunId', 'judgments']) assert.ok(!text.includes(value), value);
  assert.equal(record.kind, 'visual_request_transport');
  assert.equal(record.judgment, 'not-evaluated');
}

// Section 13 matrix: each cell traverses coordinator, real encoder, recovery
// transport, loopback HTTP, response consumption, and persistent receipt reload.
for (const wire of wires) for (const scenario of ['retained', 'removed', 'text-only', 'replaced', 'failed', 'cancelled', 'retry']) {
  test(`${wire}/${scenario}`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    const server = await endpoint(t, ({ req, attempt }) => {
      if (scenario === 'cancelled') { controller.abort(); return false; }
      if (scenario === 'failed' || (scenario === 'retry' && attempt === 1)) { req.socket.destroy(); return false; }
    });
    const source = messagesFor(wire, f.visual);
    assert.deepEqual(collectProjectedPreviewObservations(sanitizeApiMessages(source, { toolCallFormat: wire })), [f.visual]);
    const expectedImage = !['removed', 'text-only', 'replaced'].includes(scenario);
    const run = coordinated(f, wire, source, canonical => {
      let projected = canonical.messages;
      if (scenario === 'removed') projected = [{ role: 'user', content: 'image removed by projection' }];
      if (scenario === 'text-only') projected = [{ role: 'user', content: `${f.visual.artifactRef} ${f.visual.dataUrl}` }];
      let body = encode(wire, projected);
      if (scenario === 'replaced') body = body.replaceAll(png.toString('base64'), Buffer.concat([png, Buffer.from('different')]).toString('base64'));
      return transport(f, wire, server.url, body, { signal: controller.signal, retry: scenario === 'retry' });
    }, { signal: controller.signal });
    if (['failed', 'cancelled'].includes(scenario)) await assert.rejects(run);
    else assert.equal((await run).response.ok, true);
    const records = f.receipts();
    assert.equal(records.length, 1);
    const [record] = records;
    assertReceiptPrivacy(record);
    assert.equal(record.status, scenario === 'failed' ? 'failed' : scenario === 'cancelled' ? 'cancelled'
      : expectedImage ? 'response-completed' : 'image-not-transported');
    assert.equal(record.attempts.length, scenario === 'retry' ? 2 : 1);
    assert.equal(server.received.length, record.attempts.length);
    for (const [i, attempt] of record.attempts.entries()) {
      assert.equal(attempt.imagesPresent, expectedImage);
      assert.equal(attempt.bodyHash, hashVisualBytes(server.received[i].body));
      assert.equal(encodedVisualImageHashes(server.received[i].body, wire).has(f.metadata.artifactHash), expectedImage);
      assert.equal(attempt.wire, wire);
    }
    assert.equal(record.attempts[0].status, scenario === 'cancelled' ? 'cancelled'
      : ['failed', 'retry'].includes(scenario) ? 'transport-failed' : 'http-response');
  });
}

// Exercise the actual compaction/rebuild state machine, not just a changed body.
for (const wire of wires) test(`${wire}/overflow-compaction-removes-image`, async t => {
  const f = fixture(t);
  const server = await endpoint(t, ({ attempt }) => attempt === 1 ? { status: 400 } : {});
  let compactions = 0;
  const result = await coordinated(f, wire, messagesFor(wire, f.visual), async canonical => {
    const response = await transport(f, wire, server.url, encode(wire, canonical.messages));
    if (!response.ok) response.errorText = "This model's maximum prompt length is 1000000 but the request contains 1000100 tokens.";
    return response;
  }, { compactRequest: async ({ systemPrompt }) => {
    compactions++;
    return { compacted: true, systemPrompt, messages: [{ role: 'user', content: 'compacted without image' }] };
  } });
  assert.equal(compactions, 1);
  assert.equal(result.retriedAfterOverflow, true);
  const records = f.receipts();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.status).sort(), ['image-not-transported', 'response-failed']);
  assert.equal(records.find(r => r.status === 'image-not-transported').attempts[0].imagesPresent, false);
});

for (const axis of ['model', 'streamId']) test(`scope/transport-${axis}-mismatch`, async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  await assert.rejects(coordinated(f, 'openai', messagesFor('openai', f.visual), c =>
    transport(f, 'openai', server.url, encode('openai', c.messages), { [axis]: 'other' })), /transport-mismatch/);
  assert.equal(server.received.length, 0);
  assert.equal(f.receipts()[0].status, 'failed');
  assert.equal(f.receipts()[0].attempts.length, 0);
});

test('scope/cancel-before-send-does-not-prepare-receipt', async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  let invoked = false;
  await assert.rejects(createVisualRequestScope({ ...f.options, signal: controller.signal,
    messages: messagesFor('openai', f.visual) }).send(() => { invoked = true; }));
  assert.equal(invoked, false);
  assert.deepEqual(f.receipts(), []);
});

test('scope/http-headers-do-not-finish-receipt-before-adapter-consumes-body', async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  await coordinated(f, 'openai', messagesFor('openai', f.visual), async c => {
    const response = await fetchWithConnectionRecovery(server.url, { method: 'POST', body: encode('openai', c.messages) }, {
      provider: 'openai', model: f.options.model, streamId: f.options.streamId, requireElectronTransport: false,
      retryDelaysMs: [], connectTimeoutMs: 0,
    });
    assert.equal(f.receipts()[0].status, 'prepared');
    assert.equal(f.receipts()[0].completedAt, undefined);
    await response.json();
    return { ok: true };
  });
  assert.equal(f.receipts()[0].status, 'response-completed');
});

test('scope/cancel-after-http-but-before-adapter-finish', async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  const controller = new AbortController();
  await assert.rejects(coordinated(f, 'openai', messagesFor('openai', f.visual), async c => {
    const response = await transport(f, 'openai', server.url, encode('openai', c.messages));
    controller.abort();
    return response;
  }, { signal: controller.signal }));
  assert.equal(f.receipts()[0].status, 'cancelled');
  assert.equal(f.receipts()[0].attempts[0].status, 'http-response');
});

test('scope/no-transport-is-not-completed', async t => {
  const f = fixture(t);
  await coordinated(f, 'openai', messagesFor('openai', f.visual), async () => ({ ok: true }));
  assert.equal(f.receipts()[0].status, 'image-not-transported');
});

// Additional checks extend the same named transport/source axes, not UI quality.
for (const wire of wires) {
  test(`${wire}/http-error-and-stream-error`, async t => {
    const f = fixture(t);
    const server = await endpoint(t, ({ attempt }) => attempt === 1 ? { status: 400 } : { payload: { streamError: 'fixture parse failure' } });
    const messages = messagesFor(wire, f.visual);
    for (let i = 0; i < 2; i++) await coordinated(f, wire, messages, c => transport(f, wire, server.url, encode(wire, c.messages)));
    assert.equal(f.receipts().length, 2);
    for (const record of f.receipts()) { assert.equal(record.status, 'response-failed'); assertReceiptPrivacy(record); }
  });
  test(`${wire}/retry-removes-image`, async t => {
    const f = fixture(t);
    const server = await endpoint(t, ({ req, attempt }) => { if (attempt === 1) { req.socket.destroy(); return false; } });
    await coordinated(f, wire, messagesFor(wire, f.visual), c => transport(f, wire, server.url, encode(wire, c.messages), {
      retry: true, buildInit: ({ attempt }) => ({ body: encode(wire, attempt === 0 ? c.messages : [{ role: 'user', content: 'removed on retry' }]) }),
    }));
    const [record] = f.receipts();
    assert.equal(record.status, 'image-not-transported');
    assert.deepEqual(record.attempts.map(a => a.imagesPresent), [true, false]);
  });
  test(`${wire}/cloned-source-is-not-provenance`, async t => {
    const f = fixture(t);
    const server = await endpoint(t);
    const messages = structuredClone(messagesFor(wire, f.visual));
    assert.deepEqual(collectProjectedPreviewObservations(messages), []);
    await coordinated(f, wire, messages, c => transport(f, wire, server.url, encode(wire, c.messages)));
    assert.equal(f.receipts().length, 0);
    const clonedVisual = structuredClone(f.visual);
    assert.deepEqual(collectProjectedPreviewObservations(messagesFor(wire, clonedVisual)), []);
  });
}

for (const mismatch of ['conversation', 'workspace', 'store', 'stale-before', 'image-bytes']) {
  test(`source/${mismatch}`, async t => {
    const f = fixture(t);
    const options = { ...f.options, messages: messagesFor('openai', f.visual) };
    if (mismatch === 'conversation') options.conversationId = 'other';
    if (mismatch === 'workspace') options.workspacePath = os.tmpdir();
    if (mismatch === 'store') options.goalPlanStore = {};
    if (mismatch === 'stale-before') f.invalidate();
    if (mismatch === 'image-bytes') f.metadata.artifactHash = 'f'.repeat(64);
    let invoked = false;
    await assert.rejects(async () => createVisualRequestScope(options).send(() => { invoked = true; }));
    assert.equal(invoked, false);
    assert.deepEqual(f.receipts(), []);
  });
}

test('source/stale-after-http-is-not-completed', async t => {
  const f = fixture(t);
  const server = await endpoint(t, () => { f.invalidate(); });
  await assert.rejects(coordinated(f, 'openai', messagesFor('openai', f.visual), c => transport(f, 'openai', server.url, encode('openai', c.messages))), /stale/);
  assert.equal(f.receipts()[0].status, 'failed');
  assert.equal(f.receipts()[0].attempts[0].status, 'http-response');
});

test('scope/no-preview-preserves-original-send', async () => {
  const sentinel = {};
  assert.equal(createVisualRequestScope({ messages: [] }).send(() => sentinel), sentinel);
});

test('scope/concurrent-conversations-do-not-share-receipts', async t => {
  const left = fixture(t), right = fixture(t);
  const server = await endpoint(t);
  await Promise.all([left, right].map(f => coordinated(f, 'openai', messagesFor('openai', f.visual), c => transport(f, 'openai', server.url, encode('openai', c.messages)))));
  for (const f of [left, right]) {
    const [record] = f.receipts();
    assert.equal(record.observations[0].conversationId, f.options.conversationId);
    assert.equal(record.streamId, f.options.streamId);
    assert.equal(record.status, 'response-completed');
    assert.equal(record.attempts.length, 1);
  }
});

// Counterexamples that must not let an earlier request or ambient scope stand in
// for the final response-producing request.
test('scope/last-request-not-earlier-success-determines-image-presence', async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  await coordinated(f, 'openai', messagesFor('openai', f.visual), async c => {
    await transport(f, 'openai', server.url, encode('openai', c.messages));
    return transport(f, 'openai', server.url, encode('openai', [{ role: 'user', content: 'final request has no image' }]));
  });
  assert.equal(f.receipts()[0].status, 'image-not-transported');
});

test('scope/nested-nonvisual-send-does-not-inherit-receipt', async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  await createVisualRequestScope({ ...f.options, messages: messagesFor('openai', f.visual) }).send(() =>
    createVisualRequestScope({ messages: [] }).send(() => transport(f, 'openai', server.url, encode('openai', messagesFor('openai', f.visual)))));
  assert.equal(f.receipts()[0].status, 'image-not-transported');
  assert.equal(f.receipts()[0].attempts.length, 0);
});

test('source/unregistered-service-cannot-reuse-old-scope', async t => {
  const f = fixture(t);
  const scope = createVisualRequestScope({ ...f.options, messages: messagesFor('openai', f.visual) });
  unregisterDesktopPreviewService(f.store);
  await assert.rejects(scope.send(async () => ({ ok: true })), /service/);
  assert.deepEqual(f.receipts(), []);
});

test('chat-default-desktop-projection/does-not-open-visual-request', async t => {
  const f = fixture(t);
  const result = { output: 'fixture tool result', visualObservations: [f.visual] };
  const messages = [createOpenAIVisualObservationMessage([{ result }])].filter(Boolean);
  assert.deepEqual(messages, []);
  assert.deepEqual(collectProjectedPreviewObservations(messages), []);
  let invoked = false;
  await createVisualRequestScope({ ...f.options, reviewToken: undefined, messages })
    .send(async () => { invoked = true; return { ok: true }; });
  assert.equal(invoked, true);
  assert.deepEqual(f.receipts(), []);
});

test('gemini/oauth-envelope-contains-native-image', async t => {
  const f = fixture(t);
  const server = await endpoint(t);
  const body = encode('gemini', messagesFor('gemini', f.visual), { authMethod: 'oauth_google', projectId: 'fixture-project' });
  assert.ok(JSON.parse(body).request, 'exercise the real wrapped encoder path');
  await coordinated(f, 'gemini', messagesFor('gemini', f.visual), () => transport(f, 'gemini', server.url, body));
  assert.equal(f.receipts()[0].status, 'response-completed');
});

for (const wire of wires) test(`${wire}/malformed-body-cannot-prove-images`, () => {
  for (const value of [null, [], { messages: {} }, { messages: [null, { role: 'user', content: [null] }] },
    { input: [null] }, { contents: [null, { role: 'user', parts: {} }] }]) {
    assert.equal(encodedVisualImageHashes(JSON.stringify(value), wire).size, 0);
  }
});
