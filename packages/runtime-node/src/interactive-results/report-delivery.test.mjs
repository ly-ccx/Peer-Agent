import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createSessionSupervisor } from '../project-agent/session-supervisor.mjs';
import { createDesktopProjectFacts } from '../project-agent/project-facts.mjs';
import { resolveWorkSessionProfile } from '../project-agent/work-session-profile.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { createInteractiveRetention, INTERACTIVE_RETENTION_SOURCES } from './retention.mjs';
import { createLocalToolHost } from '../../../../apps/desktop/electron/main/runtime-gateway/local-tool-host.mjs';
import { normalizeTurnProfile } from '../../../../apps/desktop/electron/main/chat-runtime/turn-context.mjs';
import { createEvidenceReader } from '../../../../apps/desktop/electron/main/project-agent/evidence-reader.mjs';
import { createEvidenceDeliveryProjection } from '../../../../apps/desktop/electron/main/project-agent/evidence-deliveries.mjs';
import { installDeliveryFacts } from '../../../../apps/desktop/electron/main/project-agent/delivery-facts-port.mjs';
import { installDelegation } from '../../../../apps/desktop/electron/main/project-agent/delegation-port.mjs';
import { installDesktopInteractiveRuntime } from '../../../../apps/desktop/electron/main/interactive-results/runtime-port.mjs';

test('actual ToolHost publication → Supervisor report → post_reply → persisted Bot reference opens the original fixed result without task inference', async t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-report-delivery-')));
  const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') }), plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const parent = conversations.createConversation({ title: 'Bot', role: 'project_agent', workspaceId: 'bot' });
  conversations.appendMessage(parent.id, { id: 'anchor', role: 'user', kind: 'user_input', content: 'Compare the fixed result' });
  const history = conversations.getPersistedConversationHistory(parent.id);
  const child = conversations.createChildConversation({ parentConversationId: parent.id, role: 'work_session', anchorMessageId: 'anchor',
    delegation: { sessionId: 'session', anchorMessageId: 'anchor', inputId: 'input' }, capturedAt: new Date().toISOString(),
    runtimeState: { conversationId: parent.id, contentRevision: history.contentRevision, status: 'idle' }, backgroundMessageIds: ['anchor'], confirmMissing: true,
    title: 'Worker', workspaceId: 'bot' });
  const model = { modelProviderId: 'fixture', providerId: 'fixture', modelId: 'fixture', family: 'fixture' };
  const initial = plans.createPlan({ title: 'Fixed result', goal: 'Compare the fixed result', conversationId: child.id, status: 'executing',
    tasks: [{ taskId: 'result', title: 'Compare fixed result', status: 'pending' }],
    successCriteria: [{ id: 'semantics', kind: 'model_review', description: 'Check the fixed result' }],
    delegationOrigin: { workspaceId: 'bot', parentConversationId: parent.id, sessionId: 'session', anchorMessageId: 'anchor', inputId: 'input',
      phase: 'running', executionGeneration: 'generation', modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
  let supervisor;
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: plans, conversationStore: conversations,
    getBotConversationId: () => parent.id, holdsLease: () => true, enabled: () => true, classifyContext: () => 'D3_private',
    getSession: (id, detail = 'report') => supervisor.get({ sessionId: id, ...(detail === 'report' ? { detail } : {}) }) });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  supervisor = createSessionSupervisor({ conversationStore: conversations, goalPlanStore: plans, deferRecovery: true,
    projectReportEvidence: runtime.publications.projectReportEvidence });
  await supervisor.reconciled;
  const facts = createDesktopProjectFacts({ supervisor, approvalStore: { list: () => [] }, profileStore: { read: () => ({ agentConversationId: parent.id }) },
    conversationStore: conversations, runtimeRoot: path.join(root, 'runtime') });
  t.after(installDeliveryFacts({ read: () => facts.delivery('bot'), readResultReferences: runtime.publications.replyReferences }));
  t.after(installDelegation({ supervisor, storeDir: path.join(root, 'runtime') }));
  t.after(installDesktopInteractiveRuntime({ runtime, enabled: () => true }));
  const host = createLocalToolHost({ workspaceRoot: root, userDataPath: root,
    sessionStore: { getSession: () => ({ locale: 'en-US' }) }, hookRunner: null });
  t.after(() => host.unsubscribeRuntimeEvents());
  const worker = { workspaceId: 'bot', conversationId: child.id, turnProfile: normalizeTurnProfile(resolveWorkSessionProfile({ plan: initial, kind: 'worker' })) };
  let permissions = 0;
  const published = await host.execute({ sessionId: 'worker', call: { toolCallId: 'publish-report', capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Fixed trial', textFallback: 'Original model trial, unverified.', program: 'root=Metric("Value",2)', inputs: [],
  } } }, { toolContext: worker, requestPermission: async () => { permissions++; return { granted: true }; } });
  assert.equal(published.result.status, 'success', JSON.stringify(published.result.outputPreview)); assert.equal(permissions, 1);
  const fixed = published.result.outputPreview.artifactRef, alias = 'tool-result://publish-report';
  plans.recordEvidenceRefs({ evidenceRefs: [alias], artifactRefs: [fixed], conversationId: child.id, planId: initial.planId,
    toolCallId: 'publish-report', capabilityId: 'local.interactive.publish', toolName: 'publish_interactive_result' });
  plans.recordTaskEvidence(initial.planId, 'result', { status: 'completed', result: 'Saved fixed trial, unverified.', evidenceRefs: [alias] });
  const before = supervisor.get({ sessionId: 'session' });
  const mainContext = { mode: 'project_agent', role: 'project_agent', workspaceId: 'bot', conversationId: parent.id, turnId: 'reply-turn',
    messages: conversations.getPersistedConversationHistory(parent.id).messages, currentInputAnchors: ['anchor'] };
  const report = await host.execute({ sessionId: 'main', call: { toolCallId: 'read-report', capabilityId: 'local.delegation.get_session',
    arguments: { sessionId: 'session', detail: 'report' } } }, { toolContext: mainContext });
  assert.equal(report.result.status, 'success', JSON.stringify(report.result.outputPreview));
  const reportBody = JSON.parse(report.result.outputPreview.legacyResult.output);
  assert.ok(reportBody.report.evidenceRefs.includes(fixed)); assert.equal(reportBody.report.evidenceRefs.includes(alias), false);
  const posted = await host.execute({ sessionId: 'main', call: { toolCallId: 'post-result', capabilityId: 'local.delegation.post_reply',
    arguments: { text: 'A fixed trial is saved; its business findings are unverified.', replyTo: ['anchor'], sources: ['session'],
      statusClaims: [{ sessionId: 'session', status: before.status }] } } }, { toolContext: { ...mainContext, toolCallOrdinal: 1 } });
  assert.equal(posted.result.status, 'success', JSON.stringify(posted.result.outputPreview));
  const postedBody = JSON.parse(posted.result.outputPreview.legacyResult.output);
  assert.deepEqual(postedBody.message.meta.evidenceRefs, [fixed]); assert.equal(postedBody.message.marks.some(mark => mark.outcome === 'passed'), false);
  conversations.appendMessage(parent.id, postedBody.message);
  const restored = createConversationStore({ storeDir: path.join(root, 'conversations') }).getPersistedConversationHistory(parent.id).messages.at(-1);
  assert.deepEqual(restored.meta.evidenceRefs, [fixed]);
  assert.equal(supervisor.get({ sessionId: 'session' }).sourceRevision, before.sourceRevision);
  assert.ok(plans.getPlan(initial.planId).tasks.find(task => task.taskId === 'result').evidenceRefs.includes(alias));
  const read = createEvidenceReader({ resolveScopedRecord: runtime.publications.resolveEvidence, findRecords: refs => plans.findEvidenceIndexRecords(refs),
    projectDeliveries: createEvidenceDeliveryProjection({ getConversationId: () => parent.id, getPlan: plans.getPlan,
      getSession: id => supervisor.get({ sessionId: id, detail: 'report' }) }), readArtifact: () => { throw Error('not a file'); }, readMessages: () => [] });
  const opened = read(restored.meta.evidenceRefs[0], { context: { workspaceId: 'bot' } });
  assert.equal(opened.availability, 'available'); assert.equal(opened.deliveries[0].artifactRef, fixed);
  assert.match(opened.text, /Original model trial, unverified/); assert.equal(permissions, 1, 'reads and replies never request another publication grant');
  const reference = published.result.outputPreview.reference;
  const retire = createInteractiveRetention({ resultStore: runtime.resultStore, stateStore: runtime.stateStore, assertOwner: () => true,
    acquireRoots: () => ({ sources: Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source => [source, 'sha256:' + '0'.repeat(64)])),
      pins: [], followupIds: [], assertCurrent: () => true, release() {} }) });
  const preview = retire.preview(reference);
  retire.cleanup({ reference, requestId: 'retire-delivery', expectedDigest: preview.cleanupDigest });
  const historical = read(fixed, { context: { workspaceId: 'bot' } });
  assert.equal(historical.availability, 'available', 'the verified text receipt is readable');
  assert.equal(historical.deliveries[0].artifactRef, fixed);
  assert.match(historical.text, /Result content cleaned/);
  assert.match(historical.text, /Original model trial, unverified/);
  assert.doesNotMatch(historical.text, /root=Metric/);
  const scopedAlias = read(alias, { context: { workspaceId: 'bot', task: { planId: initial.planId, sessionId: 'session' } } });
  assert.equal(scopedAlias.text, historical.text);
  assert.equal(read(fixed, { context: { workspaceId: 'foreign' } }).availability, 'unavailable');
  assert.equal(permissions, 1);

});
