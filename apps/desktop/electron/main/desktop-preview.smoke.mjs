// Actual Electron/production-main smoke, not a visual acceptance or model test.
// Run explicitly with Electron. Uses an empty HOME/data root and only owned PIDs.
import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createLlmChatService } from './llm-chat-service.mjs';
import { runPlanVisualVerifier } from './runtime-gateway/desktop-visual-review.mjs';
import { executeDesktopProviderRequest } from './chat-runtime/provider-request-coordinator.mjs';
import { sanitizeApiMessages } from './chat-runtime/message-sanitizer.mjs';
import { createVisualRequestScope } from './provider-transports/visual-request-context.mjs';
import { sendOpenAIChatStream } from './provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from './provider-adapters/openai-responses-adapter.mjs';
import { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
import { sendGeminiStream } from './provider-adapters/gemini-adapter.mjs';
import { encodedVisualImageHashes, hashVisualBytes } from './provider-encoders/visual-request-images.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoalPlanStore, createGoalRunner } from '@peer-agent/runtime-node';
import { executeModelToolCall } from './chat-runtime/tool-orchestrator.mjs';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import { createOpenAIVisualObservationMessage, createAnthropicToolResultContent, createGeminiVisualObservationParts, INDEPENDENT_VISUAL_REVIEW_PURPOSE } from './chat-runtime/visual-observation-projection.mjs';
import { registerDesktopPreviewService, unregisterDesktopPreviewService, getDesktopPreviewService,
  isDesktopPreviewAvailable, isDesktopPreviewObservation } from './runtime-gateway/desktop-preview-service.mjs';
import { createDesktopPreviewAdapter } from './runtime-gateway/desktop-preview-adapter.mjs';
import { createDesktopPreviewArtifactStore } from './runtime-gateway/desktop-preview-artifacts.mjs';
import { createUiDeliveryAuthority } from './runtime-gateway/ui-delivery-authority.mjs';
import { deriveTaskArtifacts, extractPlanSteps } from './task-overview-aggregator.mjs';
import { createLocalDesktopPreviewProvider } from './runtime-gateway/local-desktop-preview-provider.mjs';
import { createRuntimeToolRegistry, createRuntimeProjectionFromToolRegistry, createModelToolProjectionFromRuntimeProjection } from './tools/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const home = mkdtempSync(path.join(os.tmpdir(), 'peer-preview-smoke-'));
process.env.PEER_AGENT_HOME = path.join(home, 'data');
app.setPath('userData', path.join(home, 'electron'));
let preview;
// Electron emits ready after evaluating the entry module: do not top-level await it.
app.whenReady().then(async () => {
try {
  const store = createGoalPlanStore();
  const plan = store.createPlan({ conversationId: 'preview-smoke', title: 'Preview smoke', goal: 'Observe the real isolated application',
    tasks: [{ taskId: 'observe', order: 0, title: 'Observe', status: 'pending', evidenceRefs: [] }], successCriteria: [] });
  store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
  const adapter = createDesktopPreviewAdapter({ workspaceRoot: root });
  preview = createLocalDesktopPreviewProvider({ workspaceRoot: root, userDataPath: home, goalPlanStore: store, nativeImage, adapter });
  assert.equal(isDesktopPreviewAvailable(), false);
  registerDesktopPreviewService(store, root, preview);
  assert.equal(getDesktopPreviewService(store, root), preview);
  assert.equal(getDesktopPreviewService({}, root), null);
  assert.equal(getDesktopPreviewService(store, home), null);
  const registry = createRuntimeToolRegistry({});
  const projection = createRuntimeProjectionFromToolRegistry(registry, { mode: 'goal', accessLevel: 'ask_before_local' });
  const modelProjection = createModelToolProjectionFromRuntimeProjection(projection, registry, { mode: 'goal' });
  assert.ok(modelProjection, 'model projection exists');
  assert.ok(projection.capabilities.some(c => c.capabilityId === 'local.desktop.preview'));
  let approvals = 0;
  const permissionEvents = [];
  const renderedEvents = [];
  const permissionGate = createChatPermissionGate({ activeStreams: new Map([['smoke', { permissionIds: new Set() }]]) });
  async function invoke(action, granted = true, conversationId = plan.conversationId, signal, scene) {
    const toolCallId = `preview-smoke-${action}-${approvals}`;
    // Exercise the same registry -> Runtime SDK -> Provider -> PermissionGrant chain.
    assert.ok(projection.capabilities.some(c => c.capabilityId === 'local.desktop.preview'));
    const tool = await executeModelToolCall({ name: 'desktop_preview', rawArguments: JSON.stringify({ planId: plan.planId, action, ...(scene ? { scene } : {}) }),
      toolCallId, workspacePath: root, toolContext: { conversationId, locale: 'en-US' }, conversationId, signal,
      permissionGate,
      webContents: { send(channel, payload) {
        renderedEvents.push({ channel, payload });
        if (channel !== 'chat:stream:permission-request') return;
        permissionEvents.push(payload.call);
        assert.equal(payload.call.riskLevel, 'L4_privileged');
        assert.equal(payload.call.capabilityId, 'local.desktop.preview', JSON.stringify(payload.call));
        assert.equal(payload.call.arguments.action, action);
        assert.equal(payload.call.arguments.scene, scene);
        assert.equal(payload.call.arguments.workspacePath, root);
        approvals++;
        assert.equal(permissionGate.settlePermissionRequest(payload.call.toolCallId, {
          toolCallId: payload.call.toolCallId,
          granted,
          duration: 'once', decidedAt: new Date().toISOString(),
        }), true);
      } }, streamId: 'smoke', registry, runtimeProjection: projection, goalPlanStore: store });
    if (signal?.aborted) { assert.equal(tool.aborted, true); return { tool }; }
    assert.equal(tool.aborted, false);
    return { ...tool.result.execution, tool };
  }
  const denied = await invoke('open', false);
  assert.equal(denied.result.status, 'denied');
  const opened = await invoke('open');
  assert.equal(opened.result.status, 'success', JSON.stringify(opened.result.outputPreview));
  console.log('OPEN', JSON.stringify(opened.result.outputPreview));
  const ownedHome = adapter.get(plan.conversationId).home;
  const crossed = await invoke('observe', true, 'different-conversation');
  assert.equal(crossed.tool.result.success, false);
  assert.equal(crossed.tool.result.goalModeDenied, true);
  assert.equal(crossed.tool.visualObservations.length, 0);
  const application = await invoke('observe');
  assert.equal(application.result.status, 'success');
  assert.equal(application.result.outputPreview.scene, 'application');
  const sceneDenied = await invoke('observe', false, plan.conversationId, undefined, 'background-runtime');
  assert.equal(sceneDenied.result.status, 'denied');
  const captured = await invoke('observe', true, plan.conversationId, undefined, 'background-runtime');
  assert.equal(captured.result.status, 'success', JSON.stringify(captured.result.evidence));
  assert.equal(captured.result.outputPreview.scene, 'background-runtime');
  assert.notEqual(captured.result.outputPreview.artifactHash, application.result.outputPreview.artifactHash);
  console.log('SCENE', JSON.stringify({ scene: 'background-runtime', applicationArtifact: application.result.outputPreview.artifactRef,
    artifactRef: captured.result.outputPreview.artifactRef, artifactHash: captured.result.outputPreview.artifactHash }));
  assert.equal(captured.result.status, 'success', JSON.stringify(captured.result.outputPreview));
  assert.equal(captured.tool.visualObservations.length, 1, 'real orchestrator admits registered PNG');
  const visual = captured.tool.visualObservations[0];
  assert.equal(isDesktopPreviewObservation(visual, captured.result.toolCallId), true);
  assert.equal(isDesktopPreviewObservation(structuredClone(visual), captured.result.toolCallId), false);
  assert.equal(isDesktopPreviewObservation(visual, 'another-call'), false);
  assert.ok(!JSON.stringify(renderedEvents).includes('base64,'), 'renderer events exclude image bytes');
  assert.ok(!captured.tool.output.includes('base64,'), 'tool text must not persist image bytes');
  const executions = [{ result: captured.tool }];
  assert.equal(createOpenAIVisualObservationMessage(executions), null);
  assert.equal(createAnthropicToolResultContent(captured.tool), captured.tool.output);
  assert.deepEqual(createGeminiVisualObservationParts(executions), []);
  assert.equal(createOpenAIVisualObservationMessage(executions, INDEPENDENT_VISUAL_REVIEW_PURPOSE).content[1].type, 'image_url');
  assert.ok(createAnthropicToolResultContent(captured.tool, INDEPENDENT_VISUAL_REVIEW_PURPOSE).some(block => block.type === 'image'));
  assert.ok(createGeminiVisualObservationParts(executions, INDEPENDENT_VISUAL_REVIEW_PURPOSE).some(part => part.inlineData));
  const shot = captured.result.outputPreview;
  const bytes = readFileSync(shot.filePath);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const snapshot = preview.authority.read(plan.planId);
  assert.equal(snapshot.required, true);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.judgments.length, 0);
  // Actual adapters + Electron transport + loopback SSE, not a model service.
  // The fixture observes the real PNG but never writes its body or image bytes.
  const transportRequests = [];
  const fixtureAnswer = JSON.stringify({ kind: 'ui_visual_judgment', version: 1, assessments: [{
    artifactRef: shot.artifactRef, verdict: 'passed', findings: ['LOCAL FIXTURE ONLY'], repairSuggestions: [],
  }] });
  const fixtures = {
    openai: [{ choices: [{ delta: { content: fixtureAnswer }, finish_reason: 'stop' }] }],
    'openai-responses': [{ type: 'response.output_text.delta', delta: fixtureAnswer },
      { type: 'response.completed', response: { status: 'completed', output: [] } }],
    anthropic: [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fixtureAnswer } },
      { type: 'message_stop' }],
    gemini: [{ candidates: [{ content: { role: 'model', parts: [{ text: fixtureAnswer }] }, finishReason: 'STOP' }] }],
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const pathname = req.url.split('?')[0];
    const wire = pathname.includes('chat/completions') ? 'openai'
      : pathname.includes('/responses') ? 'openai-responses'
        : pathname.includes('/messages') ? 'anthropic'
          : pathname.includes('streamGenerateContent') ? 'gemini' : pathname.slice(1);
    const imagesPresent = encodedVisualImageHashes(body, wire).has(shot.artifactHash);
    transportRequests.push({ wire, imagesPresent, bodyHash: hashVisualBytes(body) });
    if (!imagesPresent || !fixtures[wire]) { res.writeHead(400); res.end('fixture missing native PNG'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(fixtures[wire].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
      + (wire === 'openai' ? 'data: [DONE]\n\n' : ''));
  });
  const requestReceipts = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const adapters = { openai: sendOpenAIChatStream, 'openai-responses': sendOpenAIResponsesStream,
      anthropic: sendAnthropicMessagesStream, gemini: sendGeminiStream };
    const previousTrace = process.env.PEER_AGENT_PROVIDER_TRACE;
    process.env.PEER_AGENT_PROVIDER_TRACE = '0';
    try {
      for (const [wire, send] of Object.entries(adapters)) {
        let messages = [createOpenAIVisualObservationMessage(executions, INDEPENDENT_VISUAL_REVIEW_PURPOSE)];
        if (wire === 'anthropic') messages = [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'capture', name: 'desktop_preview', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'capture', content: createAnthropicToolResultContent(captured.tool, INDEPENDENT_VISUAL_REVIEW_PURPOSE) }] },
        ];
        if (wire === 'gemini') messages = [{ role: 'tool', content: captured.tool.output,
          geminiContent: { role: 'user', parts: createGeminiVisualObservationParts(executions, INDEPENDENT_VISUAL_REVIEW_PURPOSE) } }];
        const streamId = `local-fixture-${wire}`;
        const signal = AbortSignal.timeout(15_000);
        const result = await executeDesktopProviderRequest({
          request: { messages, systemPrompt: '', contextWindow: 100_000_000, conversationId: plan.conversationId,
            streamId, signal, providerConfig: { model: 'local-fixture' }, visualRequestHost: { goalPlanStore: store, workspacePath: root, reviewToken: Object.freeze({}) } },
          buildCanonicalRequest: ({ messages: projected }) => ({ messages: sanitizeApiMessages(projected, { toolCallFormat: wire }) }),
          send: canonical => send({ baseUrl, endpoint: `${baseUrl}/${wire}`, apiKey: 'fake-fixture-key',
            headers: { 'content-type': 'application/json' }, model: 'local-fixture', messages: canonical.messages,
            tools: [], effort: 'off', supportsReasoning: false, streamId, signal,
            webContents: { send(channel, payload) { renderedEvents.push({ channel, payload }); } } }),
        });
        assert.equal(result.response.ok, true, result.response.errorText);
        assert.match(result.response.content ?? result.response.textContent, /LOCAL FIXTURE ONLY/);
        const receipt = readdirSync(path.join(home, 'ui-delivery/requests'))
          .filter(name => name.endsWith('.json')).map(name => preview.requestReceipts.read(name.slice(0, -5)))
          .find(record => record.streamId === streamId);
        assert.equal(receipt.status, 'response-completed');
        assert.equal(receipt.version, 2);
        assert.match(receipt.modelRunId, /^[0-9a-f-]{36}$/);
        assert.equal(receipt.responseBinding.status, 'bound');
        assert.equal(receipt.responseBinding.attemptId, receipt.attempts[0].attemptId);
        assert.equal(receipt.responseBinding.candidate.status, 'validated-candidate');
        assert.equal(receipt.responseBinding.candidate.assessments[0].verdict, 'passed');
        assert.equal(receipt.responseBinding.candidate.assessments[0].artifactHash, shot.artifactHash);
        assert.ok(!JSON.stringify(receipt).includes('LOCAL FIXTURE ONLY'));
        assert.equal(receipt.judgment, 'not-evaluated');
        assert.equal(receipt.observations[0].artifactHash, shot.artifactHash);
        assert.equal(receipt.observations[0].scene, 'background-runtime');
        assert.equal(receipt.observations[0].instanceId, opened.result.outputPreview.instanceId);
        assert.equal(receipt.attempts.length, 1);
        assert.equal(receipt.attempts[0].bodyHash, transportRequests.at(-1).bodyHash);
        assert.equal(receipt.attempts[0].imagesPresent, true);
        assert.ok(!JSON.stringify(receipt).includes('base64,'));
        assert.ok(!JSON.stringify(receipt).includes('fake-fixture-key'));
        requestReceipts.push({ wire, requestId: receipt.requestId, status: receipt.status });
      }
      assert.equal(preview.authority.read(plan.planId).judgments.length, 0, 'ordinary candidates are not independent reviews');
      const formats = { openai: ['openai', 'openai-chat'], 'openai-responses': ['openai', 'openai-responses'],
        anthropic: ['anthropic', 'anthropic-messages'], gemini: ['google-ai', 'gemini'] };
      for (const [wire, [channelId, wireOverride]] of Object.entries(formats)) {
        const controller = new AbortController();
        const streamId = `service-fixture-${wire}`;
        const service = createLlmChatService({ goalPlanStore: store, llmConfigStore: {
          listProviders: () => [{ id: 'fixture-only', channelId, wireOverride, model: 'local-fixture', baseUrl,
            isDefault: true, apiKeyConfigured: true, supportsVision: true, supportsReasoning: false, contextWindow: 100_000_000 }],
          getDecryptedApiKey: () => 'fake-fixture-key',
        } });
        const report = await runPlanVisualVerifier({ plan, verifierRunId: streamId, signal: controller.signal,
          goalPlanStore: store, workspacePath: root, llmChatService: service, modelProviderId: 'fixture-only' });
        assert.equal(report.passed, true, 'fixture proves service wiring only');
        assert.equal(preview.authority.read(plan.planId).judgments.length, 1);
        const receipt = readdirSync(path.join(home, 'ui-delivery/requests')).map(name => preview.requestReceipts.read(name.slice(0, -5)))
          .find(record => record.streamId === streamId);
        assert.equal(receipt.responseBinding.status, 'bound');
        assert.equal(receipt.observations[0].artifactHash, shot.artifactHash);
        assert.equal(receipt.observations[0].scene, 'background-runtime');
        assert.equal(receipt.judgment, 'not-evaluated');
        requestReceipts.push({ wire, requestId: receipt.requestId, status: receipt.status, stage: 'readonly-service-fixture' });
        controller.abort();
        assert.equal(preview.authority.read(plan.planId).judgments.length, 0, 'cancel revokes fixture review before completion');
      }
    } finally {
      if (previousTrace === undefined) delete process.env.PEER_AGENT_PROVIDER_TRACE;
      else process.env.PEER_AGENT_PROVIDER_TRACE = previousTrace;
    }
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  assert.equal(transportRequests.length, 8);
  assert.ok(!JSON.stringify(renderedEvents).includes('base64,'));
  const afterTransport = preview.authority.read(plan.planId);
  assert.equal(afterTransport.judgments.length, 0);
  assert.equal(afterTransport.observations[0].admittedToRunId, '');
  console.log('LOCAL TRANSPORT ONLY', JSON.stringify({ requestReceipts, modelJudgment: 'not-run' }));
  const reloadedStore = createGoalPlanStore();
  const artifacts = createDesktopPreviewArtifactStore({ userDataPath: home, workspaceRoot: root, goalPlanStore: reloadedStore });
  const readArtifacts = () => deriveTaskArtifacts([snapshot.observations[0].evidenceRef], reloadedStore.listEvidenceIndex(),
    { resolveArtifact: artifacts.resolveArtifact }, plan);
  assert.equal(readArtifacts()[0]?.openPath, shot.filePath, 'real chat index makes screenshot retrievable after reload');
  assert.equal(readArtifacts()[0]?.kind, 'image');
  assert.ok(!JSON.stringify(readArtifacts()).includes('base64,'));
  const reloadedAuthority = createUiDeliveryAuthority({ userDataPath: home, goalPlanStore: reloadedStore,
    artifacts, currentIdentity: () => null });
  assert.equal(reloadedAuthority.read(plan.planId).observations[0].artifactHash, shot.artifactHash);
  assert.equal(reloadedAuthority.read(plan.planId).requirements[0].instanceId, 'closed', 'reload is not a current preview');
  const runner = createGoalRunner({ goalPlanStore: store, uiDeliveryAuthority: preview.authority,
    chatRuntime: { async runGoalTurn() {
      store.recordTaskEvidence(plan.planId, 'observe', { status: 'completed', evidenceRefs: [snapshot.observations[0].evidenceRef] }); return {};
    } } });
  await runner.start(plan.planId, { awaitIdle: true });
  assert.equal(store.getPlan(plan.planId).runner.status, 'blocked');
  assert.notEqual(store.getPlan(plan.planId).status, 'completed');
  assert.equal(extractPlanSteps(store.getPlan(plan.planId), store.listEvidenceIndex(),
    { resolveArtifact: artifacts.resolveArtifact })[0].artifacts[0].openPath, shot.filePath);
  const closed = await invoke('close');
  assert.equal(closed.result.status, 'success');
  assert.equal(closed.result.outputPreview.closed, true);
  assert.throws(() => process.kill(opened.result.outputPreview.pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(shot.filePath), true, 'evidence retained, child profile removed');
  assert.equal(existsSync(ownedHome), false, 'only owned instance data was removed');
  assert.equal(adapter.get(plan.conversationId), undefined);
  assert.equal(preview.authority.read(plan.planId).requirements[0].instanceId, 'closed');
  assert.deepEqual(permissionEvents.filter(call => call.capabilityId === 'local.desktop.preview')
    .map(call => [call.arguments.action, call.arguments.scene ?? 'application']),
  [['open', 'application'], ['open', 'application'], ['observe', 'application'],
    ['observe', 'background-runtime'], ['observe', 'background-runtime'], ['close', 'application']]);
  const rejectOldVisual = async () => {
    let sent = false;
    const count = readdirSync(path.join(home, 'ui-delivery/requests')).length;
    const scope = createVisualRequestScope({ messages: [createOpenAIVisualObservationMessage(executions, INDEPENDENT_VISUAL_REVIEW_PURPOSE)],
      goalPlanStore: store, workspacePath: root, conversationId: plan.conversationId,
      streamId: 'old-visual-must-not-send', model: 'local-fixture', reviewToken: Object.freeze({}) });
    await assert.rejects(scope.send(async () => { sent = true; return { ok: true }; }), /preview-source-stale/);
    assert.equal(sent, false);
    assert.equal(readdirSync(path.join(home, 'ui-delivery/requests')).length, count);
  };
  await rejectOldVisual();
  // Deterministic cancellation point after an actual second instance returns PNG.
  // This is lifecycle evidence, not a model action or product acceptance judgment.
  const second = await invoke('open');
  assert.equal(second.result.status, 'success');
  assert.notEqual(second.result.outputPreview.instanceId, opened.result.outputPreview.instanceId);
  await rejectOldVisual();
  const secondHome = adapter.get(plan.conversationId).home;
  const observationsBeforeCancel = preview.authority.read(plan.planId).observations.length;
  assert.equal(observationsBeforeCancel, 0, 'new instance does not reuse old observations');
  const controller = new AbortController();
  const realObserve = adapter.observe;
  adapter.observe = async (...args) => { const observation = await realObserve(...args); controller.abort(); return observation; };
  const cancelled = await invoke('observe', true, plan.conversationId, controller.signal, 'background-runtime');
  adapter.observe = realObserve;
  assert.equal(cancelled.tool.aborted, true);
  assert.equal(cancelled.tool.visualObservations, undefined);
  assert.equal(preview.authority.read(plan.planId).observations.length, observationsBeforeCancel, 'cancelled PNG not admitted');
  assert.equal(existsSync(secondHome), false);
  assert.throws(() => process.kill(second.result.outputPreview.pid, 0), { code: 'ESRCH' });
  unregisterDesktopPreviewService(store);
  assert.equal(getDesktopPreviewService(store, root), null);
  assert.equal(isDesktopPreviewAvailable(), false);
  console.log('PASS preview vertical smoke', JSON.stringify({ ...shot, approvals, runnerStatus: store.getPlan(plan.planId).runner.status,
    artifactRetrievalAfterReload: true, taskArtifactPathResolved: true, reloadNotCurrentEvidence: true,
    childExited: true, cancellationAfterRealCapture: true, cancelledChildExited: true, ownedProfilesRemoved: true,
    provenanceReplayRejected: true, rendererImageBytesExcluded: true, modelJudgment: 'not-run', evidenceDirectory: home }));
  await preview.dispose();
  app.exit(0);
} catch (error) {
  console.error('FAIL preview smoke', error);
  try { await preview?.dispose(); } finally { app.exit(1); }
}
}).catch(error => { console.error(error); app.exit(1); });
