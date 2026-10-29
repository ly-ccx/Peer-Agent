import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

test('delegated start and resume fail closed when isolation preparation fails', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-runner-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const model = { providerId: 'p', modelId: 'm', modelProviderId: 'pm', family: 'f' };
  for (const method of ['start', 'resume']) {
    const plan = store.createPlan({ title: method, goal: 'Never write to fallback workspace',
      tasks: [{ taskId: 't', title: 'Write', status: 'pending' }],
      delegationOrigin: { anchorMessageId: 'a', inputId: 'i', readOnly: false,
        modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
    store.recordApproval(plan.planId, { decision: 'approve' });
    let calls = 0;
    const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} },
      prepareIsolation: async () => { throw new Error('worktree unavailable'); },
      chatRuntime: { runGoalTurn: async () => { calls++; return { requestedUserInput: true }; } } });
    await assert.rejects(runner[method](plan.planId, { awaitIdle: true }), /worktree unavailable/);
    assert.equal(calls, 0);
    assert.equal(store.getPlan(plan.planId).runner.status, 'blocked');
  }
});
