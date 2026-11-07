import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createGoalPlanStore } from './goal-plan-store.mjs';

test('plan read stamp tracks the files and does not parse the body', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-stamp-'));
  const store = createGoalPlanStore({ storeDir: dir });
  try {
    const plan = store.createPlan({ title: 't', goal: 'g' });
    const first = store.planReadStamp(plan.planId);
    const started = performance.now();
    for (let i = 0; i < 30; i += 1) assert.equal(store.planReadStamp(plan.planId), first);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `30 stamps took ${elapsed}ms`);
    store.revisePlan(plan.planId, { goal: 'changed' });
    assert.notEqual(store.planReadStamp(plan.planId), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
