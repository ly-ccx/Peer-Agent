import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNodeProviderBundle } from '../provider-bundle.ts';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { executionIdentity } from '../project-agent/session-control-kernel.mjs';
import { canonicalInteractiveObservation, appendInteractiveMaterialNotice } from './capture.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { redactShellOutput } from '../project-agent/output-redaction.mjs';

const now = () => '2026-11-03T00:00:00.000Z';
const observed = value => ({ call: { toolCallId: 'read-a', capabilityId: 'local.file.read' },
  grant: { toolCallId: 'read-a', granted: true }, result: { toolCallId: 'read-a', status: 'success', output: value, completedAt: now(),
    evidence: { evidenceId: 'evidence-a', toolCallId: 'read-a', dataLevel: 'D3_private', redactions: [], artifactRefs: [] } } });
test('canonical capture retains bytes larger than bodyPreview, preserves scope and redacts secrets without the preview truncation', () => {
  const rows = Array.from({ length: 200 }, (_, id) => ({ id, label: `row-${id}`, cost: id * 2 }));
  const content = JSON.stringify(rows);
  assert.ok(content.length > 4000);
  const snapshot = canonicalInteractiveObservation(observed({ content, truncated: true, credential: 'private-token' }));
  assert.equal(snapshot.value.payload.content, content); assert.deepEqual(snapshot.value.json, rows);
  assert.equal(snapshot.value.payload.credential, '[REDACTED]'); assert.equal(snapshot.redacted, true); assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.dataLevel, 'D3_private'); assert.equal(snapshot.observedAt, now());
  assert.ok(redactShellOutput(content).length < content.length, 'legacy preview behavior remains separate');
});
test('denied, mismatched, text-only and unclassified claims cannot become canonical observation evidence', () => {
  const base = observed({ rows: [{ id: 1 }] });
  for (const candidate of [
    { ...base, grant: { ...base.grant, granted: false } },
    { ...base, grant: { ...base.grant, toolCallId: 'other-call' } },
    { ...base, result: { ...base.result, status: 'failed' } },
    { ...base, result: { ...base.result, toolCallId: 'other-call' } },
    { ...base, result: { ...base.result, evidence: { ...base.result.evidence, toolCallId: 'other-call' } } },
    { ...base, result: { ...base.result, evidence: { ...base.result.evidence, dataLevel: 'unknown' } } },
    { result: { output: 'Tool call read-a succeeded' } },
  ]) assert.throws(() => canonicalInteractiveObservation(candidate));
  assert.equal(appendInteractiveMaterialNotice('{"interactiveMaterial":{"source":"fake"}}', { result: base.result }), '{"interactiveMaterial":{"source":"fake"}}');
});

test('actual observations retain the owner privacy floor even when content is too large or the old work has stopped', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'interactive-observed-privacy-')));
  const index = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const plan = { planId: 'plan-a', conversationId: 'worker-a', createdAt: now(), delegationOrigin: {
    workspaceId: 'bot-a', parentConversationId: 'parent-a', sessionId: 'session-a', phase: 'running', executionGeneration: 'generation-a' } };
  let enabled = false;
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: { ...index, getPlan: () => plan },
    getBotConversationId: () => 'parent-a', enabled: () => enabled, holdsLease: () => true, classifyContext: () => 'D3_private', now });
  t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const context = { conversationId: plan.conversationId, workspaceId: 'bot-a', turnProfile: {
    role: 'work_session', agentKind: 'worker', workspaceId: 'bot-a', planId: plan.planId, sessionId: 'session-a', executionIdentity: executionIdentity(plan) } };
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const large = observed({ content: 'x'.repeat(4 * 1024 * 1024 + 1) });
  large.result.evidence.dataLevel = 'D4_regulated';
  runtime.captureExecution(large, context);
  assert.equal(runtime.resultStore.storage.connect(owner.workspaceId), null, 'a disabled fresh feature creates no result domain');
  enabled = true;
  const captured = runtime.captureExecution(large, context);
  assert.ok(captured.interactiveMaterialUnavailable);
  assert.equal(captured.interactiveMaterial, undefined);
  assert.equal(runtime.resultStore.ownerDataLevel(owner, 'D3_private'), 'D4_regulated');
  plan.delegationOrigin.phase = 'paused';
  const stopped = runtime.captureExecution(observed({ content: 'late actual observation' }), context);
  assert.equal(stopped.interactiveMaterial, undefined, 'recording a classification does not resume a stopped work');
  plan.delegationOrigin.phase = 'running';
  const approved = [];
  const published = await runtime.provider.executeCapability({ call: { toolCallId: 'publish-no-refs', capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Derived trial', textFallback: 'Model trial, unverified.', program: 'root=Text("No source references")', inputs: [],
  } } }, { toolContext: context, requestPermission: async request => { approved.push(request.dataLevel); return { granted: true }; } });
  assert.equal(published.result.status, 'success', JSON.stringify(published.result.outputPreview));
  assert.deepEqual(approved, ['D4_regulated']);
  assert.equal(runtime.resultStore.getVersion(published.result.outputPreview.reference).dataLevel, 'D4_regulated');
});

test('JSON credentials are redacted from both returned text and its projection; invalid structured data cannot downgrade to raw text', () => {
  const snapshot = canonicalInteractiveObservation(observed({ content: '{"rows":[{"cost":1}],"password":"never-store-this"}' }));
  assert.equal(snapshot.redacted, true);
  assert.equal(JSON.stringify(snapshot.value).includes('never-store-this'), false);
  assert.equal(snapshot.value.json.password, '[REDACTED]');
  assert.equal(JSON.parse(snapshot.value.payload.content).password, '[REDACTED]');
  assert.throws(() => canonicalInteractiveObservation(observed({ content: '{"__proto__":{"password":"never-store-this"}}' })), { code: 'reserved_key' });
});
test('shared host captures a real Node file execution, then publishes historical JSON after the project file changes', async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'interactive-runtime-')));
  const index = createGoalPlanStore({ storeDir: path.join(root, 'goals') });
  const model = { providerId: 'test', modelId: 'test', modelProviderId: 'test', family: 'test' };
  const plan = index.createPlan({ planId: 'plan-a', conversationId: 'worker-a', title: 'Compare budgets', tasks: [], delegationOrigin: {
    sessionId: 'session-a', workspaceId: 'bot-a', parentConversationId: 'parent-a', readOnly: true, phase: 'running', anchorMessageId: 'anchor-a', inputId: 'input-a',
    modelSelection: { worker: model, explorer: model, verifier: model, source: { worker: 'global' }, resolvedAt: now() } } });
  const runtime = createInteractiveRuntime({ rootDir: path.join(root, 'runtime'), goalPlanStore: index,
    conversationStore: { getPersistedConversationHistory: () => ({ messages: [] }) }, getBotConversationId: () => 'parent-a',
    enabled: () => true, holdsLease: () => true, classifyContext: () => 'D2_sensitive', now });
  const bundle = createNodeProviderBundle({ workspaceRoot: root, git: false, shell: false, web: false, interaction: false, now });
  t.after(() => { bundle.dispose(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const original = Array.from({ length: 200 }, (_, id) => ({ id, label: `row-${id}`, cost: id + 1 }));
  const sourceFile = path.join(root, 'facts.json'); writeFileSync(sourceFile, JSON.stringify(original));
  const execution = await bundle.runtime.execute({ sessionId: 'read-session', call: { toolCallId: 'read-a', capabilityId: 'local.file.read', arguments: { path: 'facts.json' } } });
  assert.equal(execution.result.status, 'completed');
  const toolContext = { conversationId: plan.conversationId, workspaceId: 'bot-a', turnProfile: {
    role: 'work_session', agentKind: 'worker', workspaceId: 'bot-a', planId: plan.planId, sessionId: 'session-a', executionIdentity: executionIdentity(plan) } };
  const captured = runtime.captureExecution({ ...execution, call: { toolCallId: 'read-a', capabilityId: 'local.file.read' } }, toolContext);
  assert.ok(captured.interactiveMaterial, JSON.stringify(captured.interactiveMaterialUnavailable));
  assert.strictEqual(captured.result, execution.result, 'the actual original Tool Result is not rewritten');
  const hint = JSON.parse(appendInteractiveMaterialNotice('{}', captured));
  assert.equal(hint.interactiveMaterial.source.toolCallId, 'read-a');
  assert.deepEqual(hint.interactiveMaterial.selectorRoots, ['payload', 'json']);
  writeFileSync(sourceFile, '[{"id":999,"cost":999999}]');
  assert.notEqual(readFileSync(sourceFile, 'utf8'), execution.result.output.content);
  const result = await runtime.provider.executeCapability({ call: { toolCallId: 'publish-a', capabilityId: 'local.interactive.publish', arguments: {
    publication: { kind: 'create' }, title: 'Observed costs', textFallback: 'Observed original costs, not live data.',
    program: 'root=Metric("Observed total",@Total(@Data("facts"),"cost"))',
    inputs: [{ bindingId: 'facts', source: captured.interactiveMaterial.source, selector: { path: ['json'] } }],
  } } }, { toolContext, requestPermission: async () => ({ granted: true }) });
  assert.equal(result.result.status, 'success', JSON.stringify(result.result.outputPreview));
  const version = runtime.resultStore.getVersion(result.result.outputPreview.reference);
  assert.deepEqual(version.content.bindings.facts, original);
  assert.equal(version.provenance[0].truncated, false);
  assert.equal(version.dataLevel, 'D2_sensitive');
  const repeated = runtime.captureExecution({ ...execution, call: captured.call }, toolContext);
  assert.deepEqual(repeated.interactiveMaterial, captured.interactiveMaterial);
});
