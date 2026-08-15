import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from './goal-plan-store.mjs';

test('createPlan: 拒绝 parentPlanId 指向自身', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-plan-relation-'));
  const store = createGoalPlanStore({ storeDir: dir });
  try {
    const planId = 'self-parent-plan';
    assert.throws(
      () => store.createPlan({
        planId,
        title: '自指根',
        parentPlanId: planId,
        sourceTaskId: 'orient',
        tasks: [{ taskId: 'orient', title: '起步' }],
      }),
      /parentPlanId cannot be its own parent/,
    );
    assert.equal(store.getPlan(planId), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
