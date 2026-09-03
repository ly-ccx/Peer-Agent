import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGoalPlanStore } from './goal-plan-store.mjs';

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-plan-quality-'));
  const store = createGoalPlanStore({ storeDir: dir });
  return { dir, store };
}

test('recordQualityReview clears stale quality_review_pending after review passed', () => {
  const { dir, store } = createTempStore();
  try {
    const plan = store.createPlan({
      title: '质检合回',
      goal: '质检通过后应能合回',
      tasks: [{ taskId: 'orient', title: '起步' }],
    });
    store.recordDeliveryHandoff(plan.planId, {
      status: 'stopped',
      repoId: 'peer_agent',
      targetBranch: '0.0.12',
      taskBranch: 'PeerAgent/task',
      stoppedReason: 'quality_review_pending',
    });
    const next = store.recordQualityReview(plan.planId, { status: 'passed' });
    assert.equal(next.qualityReview.status, 'passed');
    assert.equal(next.deliveryHandoff.status, 'idle');
    assert.equal(next.deliveryHandoff.stoppedReason, undefined);
    assert.equal(next.deliveryHandoff.targetBranch, '0.0.12');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
