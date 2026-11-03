import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { controlDigest, executionIdentity } from '../project-agent/session-control-kernel.mjs';
import { createWorkCoordinationStore } from '../project-agent/work-coordination-store.mjs';
import { registerWorkBudget } from '../project-agent/work-budget.mjs';

test('fresh store instances retain preparation identity, active candidate and repair budget; corruption never resets them', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-interactive-attempts-'));
  const options = { rootDir: root, assertCompatibility: () => true };
  const first = createInteractiveResultStore(options), second = createInteractiveResultStore(options);
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const input = toolCallId => ({ callRef: { owner, conversationId: 'child-a', toolCallId },
    source: { conversationId: 'child-a', planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId },
    draft: { publication: { kind: 'create' }, title: 'Candidate', textFallback: 'Assumption', program: 'root=Unknown()', inputs: [] } });
  const a = input('attempt-a');
  first.beginAttempt(a, () => true);
  assert.equal(second.getAttempt(a.callRef).phase, 'prepared');
  assert.throws(() => second.beginAttempt(a, () => true), { code: 'publication_unknown' });
  assert.throws(() => second.beginAttempt(input('other-concurrent'), () => true), { code: 'publication_preparation_pending' });
  assert.throws(() => second.beginAttempt({ ...a, draft: { ...a.draft, title: 'changed' } }, () => true), { code: 'publication_parameter_conflict' });
  assert.equal(second.reconcileStoppedPreparation(a.callRef, () => false), null);
  assert.equal(first.getAttempt(a.callRef).phase, 'prepared');
  const stopped = second.reconcileStoppedPreparation(a.callRef, row => row.source.executionEpoch === 'epoch-a');
  assert.equal(stopped.code, 'publication_interrupted');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(second.reconcileStoppedPreparation(a.callRef, () => true), null);
  const invalid = input('invalid-first');
  first.beginAttempt(invalid, () => true);
  first.finishAttempt(invalid.callRef, { code: 'unsupported_node', contentFailure: true });
  for (const id of ['repair-one', 'repair-two']) {
    const current = input(id); second.beginAttempt(current, () => true);
    second.finishAttempt(current.callRef, { code: 'unsupported_node', contentFailure: true });
  }
  assert.throws(() => first.beginAttempt(input('repair-three'), () => true), { code: 'interactive_repair_limit' });
  const db = first.storage.connect(owner.workspaceId, true).db;
  db.prepare('UPDATE publication_candidates SET failures=?').run(999);
  assert.throws(() => second.beginAttempt(input('corrupt-budget'), () => true), { code: 'interactive_storage_corrupt' });
  const saved = first.getAttempt(a.callRef);
  db.prepare('UPDATE attempts SET body=? WHERE id=(SELECT id FROM attempts LIMIT 1)').run(JSON.stringify({ ...saved, callRef: { ...saved.callRef, conversationId: 'foreign' } }));
  assert.throws(() => second.getAttempt(a.callRef), { code: 'interactive_storage_corrupt' });
});

test('shared host recovery consumes only a current, in-scope stop receipt after reopening both stores', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-interactive-stopped-preparation-'));
  const owner = { workspaceId: 'workspace', conversationId: 'parent' };
  const plan = { planId: 'plan', conversationId: 'child', status: 'cancelled',
    delegationOrigin: { workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session',
      phase: 'paused', executionGeneration: 'generation-one' } };
  const execution = executionIdentity(plan);
  const callRef = { owner, conversationId: plan.conversationId, toolCallId: 'prepared' };
  let lease = true;
  const journalOptions = { rootDir: path.join(root, 'coordination'), workspaceId: owner.workspaceId,
    holdsLease: () => lease, leaseEpoch: () => 'host', formatVersion: 2, fenceLegacyWrites: true };
  const runtimeOptions = { rootDir: root, goalPlanStore: {
    getPlan: id => id === plan.planId ? plan : null, assertInteractiveEvidenceCompatible: () => true,
  }, getBotConversationId: () => owner.conversationId, holdsLease: () => lease };
  let journal = createWorkCoordinationStore(journalOptions);
  let runtime = createInteractiveRuntime(runtimeOptions);
  let release = registerWorkBudget(owner.workspaceId, journal);
  t.after(() => { release(); runtime.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  await journal.prepare();
  runtime.resultStore.beginAttempt({ callRef, source: { ...execution, conversationId: 'child', toolCallId: 'prepared' },
    draft: { publication: { kind: 'create' }, title: 'Candidate', textFallback: 'Assumption', program: 'root=Text("x")', inputs: [] } }, () => true);
  const recover = () => runtime.recoverWorkspace(owner.workspaceId);
  assert.deepEqual(recover(), { ok: true, items: [] }, 'a terminal plan alone proves nothing');
  const operation = { workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan',
    kind: 'cancel', operationId: 'cancel-one', authorityRef: 'user-input', expectedExecution: execution,
    revision: 1, phase: 'recorded', updatedAt: '2026-11-01T00:00:00.000Z' };
  operation.requestDigest = controlDigest({ kind: operation.kind, operationId: operation.operationId,
    authorityRef: operation.authorityRef, execution });
  journal.writeSessionControl(operation, 0, null);
  journal.writeSessionControl({ ...operation, revision: 2, phase: 'draining' }, 1, operation.operationId);
  const stopReceipt = { receiptId: 'stop-receipt', operationId: operation.operationId, execution, scope: 'managed_execution',
    admissionClosed: true, runnerIdle: true, schedulerIdle: true, resourceClaims: [], unknownCalls: [callRef.toolCallId],
    completedAt: operation.updatedAt };
  journal.writeSessionControl({ ...operation, revision: 3, phase: 'settled', outcome: 'applied', stopReceipt }, 2, operation.operationId);
  release(); runtime.close(); journal.close();
  journal = createWorkCoordinationStore(journalOptions);
  await journal.prepare();
  runtime = createInteractiveRuntime(runtimeOptions);
  release = registerWorkBudget(owner.workspaceId, journal);
  plan.delegationOrigin.executionGeneration = 'foreign';
  assert.deepEqual(recover(), { ok: true, items: [] });
  plan.delegationOrigin.executionGeneration = execution.generation;
  lease = false;
  assert.equal(recover().ok, false);
  lease = true;
  assert.deepEqual(recover(), { ok: true, items: [{ callRef, publicationStatus: 'not_committed', code: 'publication_interrupted' }] });
  assert.equal(runtime.resultStore.getAttempt(callRef).phase, 'failed');
  assert.deepEqual(recover(), { ok: true, items: [] });
});
