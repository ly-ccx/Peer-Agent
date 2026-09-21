import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGoalPlanStore, createGoalRunner } from '@peer-agent/runtime-node';
import { evaluateUiDelivery } from '@peer-agent/protocol';
import { createLocalDesktopPreviewProvider } from './local-desktop-preview-provider.mjs';
import { createDesktopPreviewArtifactStore } from './desktop-preview-artifacts.mjs';
import { fingerprintPreviewSources, fingerprintPreviewBuild } from './desktop-preview-adapter.mjs';
import { registerDesktopPreviewService, unregisterDesktopPreviewService } from './desktop-preview-service.mjs';
import { runPlanVisualVerifier, requireDesktopVisualReview, cancelDesktopVisualReview } from './desktop-visual-review.mjs';
import { encodedVisualImageHashes } from '../provider-encoders/visual-request-images.mjs';

// Fixture PNG + loopback SSE exercise real service/encoders/transports/authority.
// They do NOT prove live model understanding or product UI acceptance.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-visual-review-tests-')));
const oldHome = process.env.PEER_AGENT_HOME;
const oldTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
process.env.PEER_AGENT_HOME = home;
process.env.PEER_AGENT_PROVIDER_TRACE = '0';
after(() => {
  if (oldHome === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = oldHome;
  if (oldTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE; else process.env.PEER_AGENT_PROVIDER_TRACE = oldTrace;
  rmSync(home, { recursive: true, force: true });
});
const { createLlmChatService } = await import('../llm-chat-service.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VvYAAAAASUVORK5CYII=', 'base64');
const formats = { openai: ['openai', 'openai-chat'], 'openai-responses': ['openai', 'openai-responses'],
  anthropic: ['anthropic', 'anthropic-messages'], gemini: ['google-ai', 'gemini'] };
function fixture(t, missing = false, scene = 'application') {
  const root = path.join(home, randomUUID()); mkdirSync(root);
  for (const dir of ['apps/desktop/electron', 'apps/desktop/renderer', 'apps/desktop/dist', 'packages', 'capabilities']) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/vite.config.ts']) writeFileSync(path.join(root, file), '{}');
  let provider;
  const store = createGoalPlanStore({ storeDir: path.join(root, 'plans'),
    readUiDelivery: plan => provider?.authority.read(plan.planId, plan) });
  const plan = store.createPlan({ conversationId: 'review', title: 'Fixture UI', goal: 'Check current fixture image', targetWorkspacePath: root,
    tasks: [{ taskId: 'observe', title: 'Observe', status: 'pending', evidenceRefs: [] }] });
  const identity = { sourceFingerprint: fingerprintPreviewSources(root), buildFingerprint: fingerprintPreviewBuild(root), instanceId: 'fixture-instance' };
  let current = { ...identity };
  const adapter = { get: () => current && ({ ...current, child: { connected: true } }), closeAll: async () => {} };
  provider = createLocalDesktopPreviewProvider({ workspaceRoot: root, userDataPath: root, goalPlanStore: store, adapter });
  const artifacts = createDesktopPreviewArtifactStore({ workspaceRoot: root, userDataPath: root, goalPlanStore: store });
  provider.authority.requirePreview(plan, identity);
  provider.authority.beginObservation(plan, scene);
  const stored = artifacts.write({ plan, observation: { ...identity, scene }, toolCallId: 'capture', png, width: 1, height: 1 });
  if (!missing) provider.authority.recordObservation(plan, stored);
  store.recordEvidenceRefs({ planId: plan.planId, conversationId: plan.conversationId, toolCallId: 'capture', toolName: 'desktop_preview',
    capabilityId: 'local.desktop.preview', evidenceRefs: [stored.evidenceRef], artifactRefs: [stored.artifactRef],
    userArtifacts: [{ ref: stored.artifactRef, kind: 'image', label: 'Fixture.png' }] });
  registerDesktopPreviewService(store, root, provider);
  t.after(() => unregisterDesktopPreviewService(store));
  const controller = new AbortController();
  const verdict = () => {
    const state = provider.authority.read(plan.planId);
    return evaluateUiDelivery(state.requirements, state.observations, state.judgments, new Set(store.listEvidenceIndex().map(r => r.evidenceRef)));
  };
  return { root, store, plan, provider, stored, controller, verdict, setCurrent(next) { current = next; } };
}
function sse(wire, text) {
  const frames = wire === 'openai' ? [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]
    : wire === 'openai-responses' ? [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed', output: [] } }]
      : wire === 'anthropic' ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
        : [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }];
  return frames.map(v => `data: ${JSON.stringify(v)}\n\n`).join('') + (wire === 'openai' ? 'data: [DONE]\n\n' : '');
}
async function service(t, f, wire, scenario) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8'); received.push(body);
    if (scenario === 'cancel') f.controller.abort();
    if (scenario === 'stale') writeFileSync(path.join(f.root, 'apps/desktop/renderer/changed.txt'), 'changed');
    const verdict = ['failed', 'inconclusive'].includes(scenario) ? scenario : 'passed';
    const report = { kind: 'ui_visual_judgment', version: 1, assessments: [{ artifactRef: f.stored.artifactRef, verdict,
      findings: ['fixture-private-answer'], repairSuggestions: verdict === 'failed' ? ['fixture-fix'] : [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(wire, scenario === 'malformed' ? 'not a report' : JSON.stringify(report)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  let credentials = 0;
  const [channelId, wireOverride] = formats[wire];
  const config = { id: 'fixture', channelId, wireOverride, model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}`,
    supportsVision: scenario !== 'no-vision', supportsReasoning: false, contextWindow: 100000, apiKeyConfigured: true, isDefault: true };
  const llm = createLlmChatService({ goalPlanStore: f.store, llmConfigStore: {
    listProviders: () => [config], getDecryptedApiKey: () => { credentials++; return 'fixture-not-a-secret'; },
  }, conversationStore: { getConversation(id) { assert.ok(!id, 'must not load a daily conversation'); return null; },
    saveConversation() { throw new Error('must not persist review'); } } });
  return { llm, received, config, credentials: () => credentials,
    invoke: () => runPlanVisualVerifier({ plan: f.plan, verifierRunId: `review:${randomUUID()}`, signal: f.controller.signal,
      goalPlanStore: f.store, workspacePath: f.root, llmChatService: llm, modelProviderId: 'fixture' }) };
}
for (const wire of Object.keys(formats)) {
  for (const scene of ['application', 'background-runtime']) for (const scenario of ['passed', 'failed', 'inconclusive', 'missing-image', 'no-vision', 'cancel', 'stale', 'malformed']) {
    test(`${wire}/${scene}/${scenario}/readonly-visual-review`, async t => {
      const f = fixture(t, scenario === 'missing-image', scene);
      const s = await service(t, f, wire, scenario);
      f.store.setPlanStatus(f.plan.planId, 'executing');
      f.store.recordTaskEvidence(f.plan.planId, 'observe', { status: 'completed', evidenceRefs: [f.stored.evidenceRef] });
      assert.equal(f.store.getPlan(f.plan.planId).status, 'executing', 'captured image alone is not completion');
      if (['passed', 'failed', 'inconclusive'].includes(scenario)) {
        const report = await s.invoke();
        assert.equal(report.passed, scenario === 'passed');
        assert.equal(f.verdict().passed, scenario === 'passed');
        const snapshot = f.provider.authority.read(f.plan.planId);
        assert.equal(snapshot.judgments.length, 1);
        assert.ok(snapshot.observations.at(-1).admittedToRunId);
        assert.equal(f.store.setPlanStatus(f.plan.planId, 'completed').status,
          scenario === 'passed' ? 'completed' : 'executing');
        f.controller.abort();
        assert.equal(f.verdict().passed, false, 'cancel after response revokes in-memory judgment');
        assert.equal(f.store.getPlan(f.plan.planId).status, 'executing', 'revoked judgment also revokes completed projection');
      } else {
        await assert.rejects(s.invoke());
        assert.equal(f.verdict().passed, false);
        const rejectedSnapshot = f.provider.authority.read(f.plan.planId);
        if (scenario === 'no-vision') {
          assert.equal(rejectedSnapshot.judgments.length, 1, 'deterministic vision failure must surface');
          assert.equal(rejectedSnapshot.judgments[0].decision, 'failed');
          assert.equal(rejectedSnapshot.judgments[0].reason, 'visual-review-vision-unavailable');
        } else {
          assert.equal(rejectedSnapshot.judgments.length, 0);
        }
      }
      if (['missing-image', 'no-vision'].includes(scenario)) {
        assert.equal(s.credentials(), 0); assert.equal(s.received.length, 0);
      } else {
        assert.equal(s.received.length, 1);
        assert.deepEqual([...encodedVisualImageHashes(s.received[0], wire)], [f.stored.artifactHash]);
        assert.match(s.received[0], /ui_visual_judgment/);
        assert.ok(s.received[0].includes(scene), 'scene facts must reach the model request');
        const body = JSON.parse(s.received[0]); assert.ok(!body.tools?.length, 'no tool execution loop');
        const receipts = readdirSync(path.join(f.root, 'ui-delivery/requests')).map(name => readFileSync(path.join(f.root, 'ui-delivery/requests', name), 'utf8'));
        assert.equal(receipts.length, 1);
        for (const raw of receipts) {
          assert.doesNotMatch(raw, /fixture-private-answer|fixture-not-a-secret|base64/);
          assert.equal(JSON.parse(raw).judgment, 'not-evaluated');
          assert.equal(JSON.parse(raw).observations[0].scene, scene);
        }
      }
    });
  }
}

test('review handles reject cloning, wrong scope and repeated use', async t => {
  const f = fixture(t); const handle = f.provider.prepareVisualReview(f.plan.planId, 'review-id', f.controller.signal);
  const scope = { goalPlanStore: f.store, mode: 'explorer', ephemeral: true, conversationId: null };
  assert.throws(() => requireDesktopVisualReview(structuredClone(handle), scope), /scope/);
  for (const changed of [{ goalPlanStore: {} }, { mode: 'chat' }, { ephemeral: false }, { conversationId: 'daily' }]) {
    assert.throws(() => requireDesktopVisualReview(handle, { ...scope, ...changed }), /scope/);
  }
  assert.equal(requireDesktopVisualReview(handle, scope).verifierContext.stage, 'visual');
  cancelDesktopVisualReview(handle);
  assert.throws(() => requireDesktopVisualReview(handle, scope), /scope/);
});

for (const scenario of ['passed', 'failed', 'inconclusive']) {
  test(`runner/service/${scenario}/fixture-only`, async t => {
    const f = fixture(t); const s = await service(t, f, 'openai', scenario);
    f.store.recordApproval(f.plan.planId, { decision: 'approve', decidedBy: 'test' });
    const stages = [];
    const runner = createGoalRunner({ goalPlanStore: f.store, uiDeliveryAuthority: f.provider.authority,
      verifierRunner: { async runVerifier(args) {
        stages.push(args.stage || 'evidence');
        if (args.stage === 'visual') return runPlanVisualVerifier({ ...args, goalPlanStore: f.store,
          workspacePath: f.root, llmChatService: s.llm, modelProviderId: 'fixture' });
        return { passed: true, evidenceRefs: [f.stored.evidenceRef] };
      } }, chatRuntime: { async runGoalTurn() {
        f.store.recordTaskEvidence(f.plan.planId, 'observe', { status: 'completed', evidenceRefs: [f.stored.evidenceRef] });
        return {};
      } } });
    await runner.start(f.plan.planId, { awaitIdle: true });
    const plan = f.store.getPlan(f.plan.planId);
    assert.equal(plan.runner.status, scenario === 'passed' ? 'completed' : 'blocked');
    assert.equal(stages[0], 'visual');
    assert.equal(stages.filter((stage) => stage === 'visual').length, scenario === 'passed' ? 1 : 3);
    assert.equal(s.received.length, scenario === 'passed' ? 1 : 3);
    const persisted = JSON.stringify(plan);
    assert.doesNotMatch(persisted, /fixture-not-a-secret|base64/);
    if (scenario === 'passed') {
      assert.doesNotMatch(persisted, /fixture-private-answer|fixture-fix/);
    } else {
      assert.equal(plan.runner.blockedReason, 'visual_repair_exhausted');
      assert.equal(plan.runner.visualRepair.attempts, 2);
      assert.equal(plan.runner.visualRepair.maxAttempts, 2);
      assert.equal(plan.runner.visualRepair.feedback.verdict, scenario);
      assert.match(persisted, /fixture-private-answer/);
    }
    runner.pause(f.plan.planId);
    assert.equal(f.provider.authority.read(f.plan.planId).judgments.length, 0);
  });
}

test('independent review sends the same grok identity headers as chat', async t => {
  const f = fixture(t);
  const received = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init = {}) => {
    received.push({ url: String(url), headers: init.headers || {} });
    return new Response('Upgrade Required', { status: 426, headers: { 'content-type': 'text/plain' } });
  };
  const config = { id: 'fixture', channelId: 'grok', authMethod: 'oauth_grok', model: 'grok-4.6',
    supportsVision: true, supportsReasoning: false, contextWindow: 100000, apiKeyConfigured: true, isDefault: true };
  const llm = createLlmChatService({ goalPlanStore: f.store, llmConfigStore: {
    listProviders: () => [config], getDecryptedApiKey: () => 'fixture-not-a-secret',
    getCredential: () => ({ tokens: { access: 'fixture-not-a-secret', scope: 'api:access', expires: Date.now() + 3_600_000 } }),
  }, conversationStore: { getConversation() { return null; }, saveConversation() { throw new Error('must not persist review'); } } });
  await assert.rejects(runPlanVisualVerifier({ plan: f.plan, verifierRunId: `review:${randomUUID()}`,
    signal: f.controller.signal, goalPlanStore: f.store, workspacePath: f.root, llmChatService: llm, modelProviderId: 'fixture' }));
  assert.equal(received.length, 1, 'review must still reach Grok');
  const headers = received[0].headers;
  const value = (name) => headers[name] ?? headers[name.toLowerCase()];
  assert.equal(value('x-grok-client-surface'), 'grok-build');
  assert.equal(value('x-grok-client-version'), '0.1.202');
  assert.equal(value('X-XAI-Token-Auth') ?? value('x-xai-token-auth'), 'xai-grok-cli');
  assert.match(String(value('Authorization') ?? value('authorization') ?? ''), /^Bearer /);
});

test('unsupported wire and unavailable selected model fail before credential lookup', async t => {
  const f = fixture(t); const s = await service(t, f, 'openai', 'passed');
  s.config.wireOverride = 'not-a-supported-wire';
  await assert.rejects(s.invoke(), /wire/);
  assert.equal(s.credentials(), 0); assert.equal(s.received.length, 0);
  s.config.wireOverride = 'openai-chat'; s.config.id = 'different-provider';
  await assert.rejects(s.invoke(), /selected-provider-missing/);
  assert.equal(s.credentials(), 0); assert.equal(s.received.length, 0);
});

for (const scene of ['application', 'background-runtime']) {
  test(`${scene}/failed recapture cannot retain an earlier passing judgment`, async t => {
    const f = fixture(t, false, scene); const s = await service(t, f, 'openai', 'passed');
    await s.invoke(); assert.equal(f.verdict().passed, true);
    f.provider.authority.beginObservation(f.plan, scene);
    // No replacement observation arrives (failed/cancelled capture).
    // History stays on disk, but the in-flight recapture must not grant the previous pass.
    assert.equal(f.verdict().passed, false);
    const snapshot = f.provider.authority.read(f.plan.planId);
    assert.equal(snapshot.observations.length, 1);
    assert.equal(snapshot.judgments.length, 0);
    assert.throws(() => f.provider.prepareVisualReview(f.plan.planId, 'after-failure', f.controller.signal), /current-image-missing/);
  });
}

test('fresh capture invalidates the previous independent review', async t => {
  const f = fixture(t); const s = await service(t, f, 'openai', 'passed');
  await s.invoke(); assert.equal(f.verdict().passed, true);
  const artifacts = createDesktopPreviewArtifactStore({ workspaceRoot: f.root, userDataPath: f.root, goalPlanStore: f.store });
  const next = artifacts.write({ plan: f.plan, observation: f.stored, toolCallId: 'capture-next', png, width: 1, height: 1 });
  f.store.recordEvidenceRefs({ planId: f.plan.planId, conversationId: f.plan.conversationId, toolCallId: 'capture-next',
    toolName: 'desktop_preview', capabilityId: 'local.desktop.preview', evidenceRefs: [next.evidenceRef], artifactRefs: [next.artifactRef],
    userArtifacts: [{ ref: next.artifactRef, kind: 'image', label: 'Next.png' }] });
  f.provider.authority.recordObservation(f.plan, next);
  assert.equal(f.provider.authority.read(f.plan.planId).judgments.length, 0);
  assert.equal(f.verdict().passed, false);
});

test('failed re-review replaces success; restart re-reads only the latest verified review', async t => {
  const f = fixture(t); const good = await service(t, f, 'openai', 'passed');
  await good.invoke(); assert.equal(f.verdict().passed, true);
  const bad = await service(t, f, 'openai', 'failed');
  await bad.invoke(); assert.equal(f.verdict().passed, false);
  const restarted = createLocalDesktopPreviewProvider({ workspaceRoot: f.root, userDataPath: f.root, goalPlanStore: f.store,
    adapter: { get: () => ({ instanceId: 'fixture-instance', child: { connected: true } }), closeAll: async () => {} } });
  const snapshot = restarted.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 1, 'the review is durable, not memory-only');
  assert.equal(snapshot.judgments[0].decision, 'failed', 'a failed re-review must never be recoverable as a pass');
  assert.equal(evaluateUiDelivery(snapshot.requirements, snapshot.observations, snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(r => r.evidenceRef))).passed, false);
});

test('restart re-reads a verified persisted pass instead of degrading to judgment-missing', async t => {
  const f = fixture(t); const s = await service(t, f, 'openai', 'passed');
  await s.invoke(); assert.equal(f.verdict().passed, true);
  const restarted = createLocalDesktopPreviewProvider({ workspaceRoot: f.root, userDataPath: f.root, goalPlanStore: f.store,
    adapter: { get: () => ({ instanceId: 'fixture-instance', child: { connected: true } }), closeAll: async () => {} } });
  const snapshot = restarted.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'passed');
  assert.equal(snapshot.observations.at(-1).admittedToRunId, snapshot.judgments[0].modelRunId);
  const gate = evaluateUiDelivery(snapshot.requirements, snapshot.observations, snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(r => r.evidenceRef)));
  assert.equal(gate.passed, true, 'a durable pass still has to satisfy the delivery gate');
});

test('a persisted judgment without indexed review Evidence grants nothing', async t => {
  const f = fixture(t); const s = await service(t, f, 'openai', 'passed');
  await s.invoke(); assert.equal(f.verdict().passed, true);
  const recordPath = path.join(f.root, 'ui-delivery', `${createHash('sha256').update(f.plan.planId).digest('hex')}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.judgments[0].evidenceRef = 'visual-review://forged';
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  const restarted = createLocalDesktopPreviewProvider({ workspaceRoot: f.root, userDataPath: f.root, goalPlanStore: f.store,
    adapter: { get: () => ({ instanceId: 'fixture-instance', child: { connected: true } }), closeAll: async () => {} } });
  const snapshot = restarted.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 0);
  assert.equal(snapshot.observations.at(-1).admittedToRunId, '');
  assert.equal(evaluateUiDelivery(snapshot.requirements, snapshot.observations, snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(r => r.evidenceRef))).passed, false);
});

test('prepareVisualReview/idle-closed/reviews-captured-image', t => {
  const f = fixture(t);
  f.setCurrent(null);
  const handle = f.provider.prepareVisualReview(f.plan.planId, 'after-close', f.controller.signal);
  assert.equal(typeof handle, 'object');
  assert.equal(f.provider.authority.read(f.plan.planId).observations[0].instanceId, 'fixture-instance');
});

test('prepareVisualReview/replaced-instance/persists-failure-before-token', t => {
  const f = fixture(t);
  f.setCurrent({ sourceFingerprint: 'c'.repeat(64), buildFingerprint: 'd'.repeat(64), instanceId: 'instance-2' });
  assert.throws(() => f.provider.prepareVisualReview(f.plan.planId, 'after-move', f.controller.signal),
    /current-image-missing/);
  const snapshot = f.provider.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'failed');
  assert.equal(snapshot.judgments[0].reason, 'visual-review-current-image-missing');
  assert.equal(snapshot.judgments[0].modelRunId, null);
});

test('deterministic review failure is durable and releases the close gate', async t => {
  const f = fixture(t); const s = await service(t, f, 'openai', 'passed');
  await s.invoke(); assert.equal(f.verdict().passed, true);
  // A deterministic failure (e.g. non-vision provider) must surface as a durable 'failed'
  // judgment so the close gate can release with a diagnosable reason instead of pending forever.
  const handle = f.provider.prepareVisualReview(f.plan.planId, 'fail-run', f.controller.signal);
  const review = requireDesktopVisualReview(handle, { goalPlanStore: f.store, mode: 'explorer', ephemeral: true, conversationId: null });
  assert.equal(typeof review.recordFailure, 'function', 'failure path must be exposed on the review handle');
  review.recordFailure('visual-review-vision-unavailable');
  const snapshot = f.provider.authority.read(f.plan.planId);
  assert.equal(snapshot.judgments.length, 1);
  assert.equal(snapshot.judgments[0].decision, 'failed');
  assert.equal(snapshot.judgments[0].reason, 'visual-review-vision-unavailable');
  const gate = evaluateUiDelivery(snapshot.requirements, snapshot.observations, snapshot.judgments,
    new Set(f.store.listEvidenceIndex().map(r => r.evidenceRef)));
  assert.equal(gate.passed, false, 'a failed review is not a pass');
  f.controller.abort();
});
