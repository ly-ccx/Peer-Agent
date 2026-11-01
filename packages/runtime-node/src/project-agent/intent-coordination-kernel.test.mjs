import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { admitIntentAssessment, admitIntentClosure, reduceIntentCoordination } from './intent-coordination-kernel.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createCoordinationJournalReader } from './coordination-journal-reader.mjs';

const host = { holdsLease: true, workspaceId: 'w', parentConversationId: 'p', currentInputIds: ['i'], eventIds: [], now: '2026-11-01T00:00:00Z' };
const state = () => ({ works: { g: { workId: 'g', workspaceId: 'w', parentConversationId: 'p', state: 'runnable', anchorInputIds: ['i'] } },
  mandates: { g: { goalRevision: 1, lifecycle: 'active', sessionIds: ['s'], rootInputIds: ['i'] } }, deliveries: {} });
const assessment = () => ({ operationId: 'd', workId: 'g', expectedWorkRevision: 0, expectedGoalRevision: 1,
  sourceInputIds: ['i'], sourceEventIds: [], inputs: [{ inputId: 'i', kind: 'delegate', reason: 'User requested implementation.' }],
  interpretation: { outcome: 'Research and implement', constraints: [], nonGoals: [], openQuestions: [], requirements: [
    { requirementId: 'research', text: 'Inspect cause', sourceInputIds: ['i'] }, { requirementId: 'fix', text: 'Implement fix', sourceInputIds: ['i'] }] },
  coverage: [{ requirementId: 'research', status: 'covered', explanation: 'Verified research', sources: [{ sessionId: 's', sourceRevision: 'r1', evidenceRefs: ['ev'] }] },
    { requirementId: 'fix', status: 'remaining', explanation: 'Implementation remains', sources: [] }],
  disposition: { kind: 'continue', operationRefs: ['next'] }, reason: 'Research is a stage, not root completion.' });

test('input provenance, Bot scope, every input disposition and independent revisions are enforced', () => {
  const s = state(), a = assessment();
  assert.equal(admitIntentAssessment(s, a, host).ok, true);
  for (const [patch, error] of [[{ expectedWorkRevision: 1 }, 'work_revision_conflict'], [{ expectedGoalRevision: 0 }, 'goal_revision_conflict'],
    [{ sourceInputIds: ['forged'] }, 'source_not_admitted'], [{ inputs: [] }, 'input_disposition_required'], [{ coverage: [] }, 'goal_coverage_incomplete']]) {
    assert.equal(admitIntentAssessment(s, { ...a, ...patch }, host).error, error);
  }
  assert.equal(admitIntentAssessment(s, a, { ...host, parentConversationId: 'other' }).error, 'out_of_scope');
  assert.equal(admitIntentAssessment(s, a, { ...host, holdsLease: false }).error, 'coordination_lease_lost');
  assert.equal(admitIntentAssessment(s, { ...a, permissionGrant: 'forged' }, host).error, 'invalid_intent_assessment');
});

test('one operation is idempotent; a consumed event continues through the persisted decision only', () => {
  const a = assessment(), admitted = admitIntentAssessment(state(), a, host);
  const s = reduceIntentCoordination(state(), admitted.entry);
  assert.equal(admitIntentAssessment(s, a, host).replayed, true);
  assert.equal(admitIntentAssessment(s, { ...Object.fromEntries(Object.entries(a).reverse()), interpretation: Object.fromEntries(Object.entries(a.interpretation).reverse()) }, host).replayed, true);
  assert.equal(admitIntentAssessment(s, { ...a, reason: 'changed' }, host).error, 'operation_identity_conflict');
  const next = { ...a, operationId: 'd2', expectedWorkRevision: 1, sourceInputIds: [], inputs: [], interpretation: undefined, sourceDecisionRef: 'd' };
  assert.equal(admitIntentAssessment(s, next, { ...host, currentInputIds: [] }).ok, true);
  assert.equal(admitIntentAssessment(s, { ...next, sourceDecisionRef: 'invented' }, host).error, 'intent_source_required');
  assert.equal(s.works.g.intentCoordination.lifecycle, 'active');
  assert.equal(s.permissionGrants, undefined);
});

test('accepted research, missing coverage, stale goal, undelivered reply and unverified closure cannot close the root', () => {
  const s = reduceIntentCoordination(state(), admitIntentAssessment(state(), assessment(), host).entry);
  const request = { operationId: 'close', workId: 'g', expectedWorkRevision: 1, expectedGoalRevision: 1, lifecycle: 'fulfilled' };
  assert.equal(admitIntentClosure(s, request, host).error, 'goal_coverage_incomplete');
  const next = { ...assessment(), operationId: 'return', expectedWorkRevision: 1, disposition: { kind: 'return', replyRef: 'reply' },
    coverage: assessment().coverage.map(row => ({ ...row, status: 'covered', sources: assessment().coverage[0].sources })) };
  const s2 = reduceIntentCoordination(s, admitIntentAssessment(s, next, host).entry);
  const close = { ...request, expectedWorkRevision: 2 };
  assert.equal(admitIntentClosure(s2, close, host).error, 'goal_delivery_pending');
  s2.deliveries.reply = { state: 'delivered', message: { id: 'reply', content: 'Actual delivered result', meta: { workId: 'g', sessionStates: [{ sessionId: 's', sourceRevision: 'r1', status: 'result_ready' }], intentBindings: [
    { workId: 'g', goalRevision: 1, intentRevision: 2, decisionRef: 'return' }] } } };
  assert.equal(admitIntentClosure(s2, close, host).error, 'goal_review_required');
  const reviewed = { ...host, pendingObligations: false, verifiedGoalRevision: 1, reviewRef: 'review:1' };
  s2.works.g.intentCoordination.review = { reviewRef: 'review:1', passed: true, goalRevision: 1, intentRevision: 2, sources: [{ sessionId: 's', sourceRevision: 'r1' }] };
  const admitted = admitIntentClosure(s2, close, reviewed); assert.equal(admitted.ok, true);
  const closed = reduceIntentCoordination(s2, admitted.entry);
  assert.equal(closed.works.g.intentCoordination.lifecycle, 'fulfilled');
  assert.equal(admitIntentClosure(closed, close, reviewed).replayed, true);
  s2.mandates.g.goalRevision = 2;
  assert.equal(admitIntentClosure(s2, close, reviewed).error, 'intent_closure_conflict');
});

test('v8 intent facts survive index loss, preserve format floor, fence legacy writers and reject unimplemented v7', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-intent-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true };
  let store = createWorkCoordinationStore(options);
  try {
    await store.prepare(); store.saveWork(state().works.g);
    // Goal revision zero is valid for pre-delegation interpretation; it grants no execution rights.
    const a = assessment(); a.expectedGoalRevision = 0; a.coverage.forEach(row => { row.sources = []; row.status = 'remaining'; });
    const result = store.assessIntent(a, host); assert.equal(result.ok, true);
    assert.equal(store.assessIntent(a, host).replayed, true);
    const expected = store.read(); store.close();
    const base = path.join(rootDir, 'w');
    assert.throws(() => createCoordinationJournalReader({ file: path.join(base, 'coordination.jsonl') }).read(), /coordination_writer_upgrade_required/);
    rmSync(path.join(base, '.read-models'), { recursive: true, force: true });
    store = createWorkCoordinationStore(options); await store.prepare();
    assert.deepEqual(store.read(), expected);
    const file = path.join(base, 'coordination-v2/manifest.json'), manifest = JSON.parse(readFileSync(file));
    assert.equal(manifest.minimumReaderVersion, 8); assert.equal(manifest.minimumWriterVersion, 8);
    writeFileSync(file, JSON.stringify({ ...manifest, minimumReaderVersion: 7, minimumWriterVersion: 7 }));
    assert.throws(() => store.read(), /coordination_schema_unsupported/);
  } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('withdrawal needs an applied current control and stopped managed sessions; it retains unknown history without fulfilling the goal', () => {
  let s = state(); s.transitions = { cancel: { workId: 'g', action: 'cancel', phase: 'completed', expectedGoalRevision: 1 } };
  s.works.g.budget = { uncertainDispatches: [{ toolCallId: 'historical-unknown' }] };
  const a = { ...assessment(), disposition: { kind: 'withdraw', controlRef: 'cancel' } };
  s = reduceIntentCoordination(s, admitIntentAssessment(s, a, host).entry);
  const request = { operationId: 'withdraw', workId: 'g', expectedWorkRevision: 1, expectedGoalRevision: 1, lifecycle: 'cancelled' };
  assert.equal(admitIntentClosure(s, request, { ...host, appliedControlRef: 'cancel', pendingManagedSessions: true }).error, 'goal_control_required');
  const closed = admitIntentClosure(s, request, { ...host, appliedControlRef: 'cancel', pendingManagedSessions: false });
  assert.equal(closed.ok, true); s = reduceIntentCoordination(s, closed.entry);
  assert.equal(s.works.g.intentCoordination.lifecycle, 'cancelled'); assert.equal(s.works.g.budget.uncertainDispatches.length, 1);
});
