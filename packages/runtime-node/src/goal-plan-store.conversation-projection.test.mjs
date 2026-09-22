import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-conversation-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads = [];
  let valid = true;
  const identity = { id: 'panel', host: 'desktop', requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
  const readUiDelivery = plan => {
    reads.push(plan.planId);
    assert.ok(plan.tasks.length, 'authority receives the full plan');
    return {
      required: true,
      requirements: [identity],
      observations: [{ ...identity, requirementId: 'panel', artifactHash: 'hash', evidenceRef: 'image', admittedToRunId: 'review' }],
      judgments: valid ? [{ requirementId: 'panel', observationRef: 'image', evidenceRef: 'judgment', modelRunId: 'review', decision: 'passed' }] : [],
    };
  };
  const makeStore = () => createGoalPlanStore({ storeDir: root, readUiDelivery });
  const store = makeStore();
  const ids = [];
  for (const conversationId of ['target', 'other-a', 'other-b']) {
    const plan = store.createGoalContract({ conversationId, goal: 'Inspect panel', tasks: [{ taskId: 'observe', title: 'Inspect panel' }] });
    store.setPlanStatus(plan.planId, 'executing');
    store.recordEvidenceRefs({ planId: plan.planId, conversationId, evidenceRefs: ['image', 'judgment'] });
    store.recordTaskEvidence(plan.planId, 'observe', { status: 'completed', evidenceRefs: ['image'] });
    assert.equal(store.getPlan(plan.planId).status, 'completed');
    ids.push(plan.planId);
  }
  return { root, store, makeStore, reads, ids, setValid: value => { valid = value; } };
}

// Query kind × authority state × index cache state. Every cell also checks that
// other conversations are excluded BEFORE authority/Evidence reads, not after.
for (const method of ['listPlansByConversation', 'listPlanDetailsByConversation']) {
  for (const valid of [true, false]) {
    for (const cache of ['cold', 'warm']) {
      test(`${method}/${valid ? 'valid' : 'revoked'}/${cache}/only-project-matching-conversation`, t => {
        const f = fixture(t);
        const store = f.makeStore();
        if (cache === 'warm') store.listPlans();
        f.setValid(valid);
        f.reads.length = 0;
        const result = store[method]('target');
        assert.deepEqual(result.map(plan => plan.planId), [f.ids[0]]);
        assert.equal(result[0].status, valid ? 'completed' : 'executing');
        assert.deepEqual(f.reads, [f.ids[0]], 'one authority read for the matching plan; none for other conversations');
        assert.equal(JSON.parse(readFileSync(path.join(f.root, `${f.ids[0]}.json`), 'utf8')).status, 'completed', 'projection does not rewrite history');
        f.reads.length = 0;
        assert.deepEqual(store[method]('absent'), []);
        assert.deepEqual(store[method](null), []);
        assert.deepEqual(f.reads, []);
      });
    }
  }
}

test('full-list/repeated-read/authority-revocation-is-never-cached', t => {
  const f = fixture(t);
  assert.ok(f.store.listPlans().every(plan => plan.status === 'completed'));
  f.setValid(false);
  f.reads.length = 0;
  assert.ok(f.store.listPlans().every(plan => plan.status === 'executing'));
  assert.deepEqual([...f.reads].sort(), [...f.ids].sort());
  f.setValid(true);
  assert.ok(f.store.listPlans().every(plan => plan.status === 'completed'));
});
