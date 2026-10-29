import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

for (const outcome of ['error', 'result']) {
  for (const stopped of ['handoff', 'cancelled', 'lease_lost']) {
    test(`late ${outcome} preserves ${stopped} and cannot fail its leaf`, async t => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'goal-handoff-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const store = createGoalPlanStore({ storeDir: root });
      const model = { providerId: 'local', modelId: 'model', modelProviderId: 'channel', family: 'test' };
      const plan = store.createPlan({ conversationId: 'handoff', title: 'Independent work', goal: 'Read A',
        tasks: [{ taskId: 'read', title: 'Read A', status: 'pending' }],
        delegationOrigin: { phase: 'running', sessionId: 's1', anchorMessageId: 'user', inputId: 'user', readOnly: true,
          modelSelection: { worker: model, explorer: model, verifier: model, resolvedAt: new Date().toISOString() } } });
      store.promoteIntakeToGoal(plan.planId);
      let began, settle, owner = true;
      const started = new Promise(resolve => { began = resolve; });
      const pending = new Promise((resolve, reject) => { settle = () => outcome === 'error'
        ? reject(new Error('coordination_lease_lost')) : resolve({ failed: true, failureReason: 'stale error' }); });
      const runner = createGoalRunner({ goalPlanStore: store, canRunPlan: () => owner, logger: { warn() {} },
        chatRuntime: { async runGoalTurn() { began(); return pending; } } });
      await runner.resume(plan.planId);
      await started;
      if (stopped === 'handoff') runner.pause(plan.planId, 'host_handoff');
      if (stopped === 'cancelled') runner.clear(plan.planId, 'user correction');
      owner = false;
      const before = store.getPlan(plan.planId);
      settle();
      await runner.waitForIdle(plan.planId);
      assert.deepEqual(store.getPlan(plan.planId), before, 'old owner must not mutate persisted state');
      assert.equal(before.tasks[0].status, 'pending');
      if (stopped === 'handoff') {
        assert.equal(before.status, 'paused');
        assert.equal(before.runner.blockedReason, 'host_handoff');
        assert.equal(before.delegationOrigin.pausedFromPhase, 'running');
        let calls = 0;
        const next = createGoalRunner({ goalPlanStore: store, canRunPlan: () => true, logger: { warn() {} },
          chatRuntime: { async runGoalTurn() { calls++; return { requestedUserInput: true }; } } });
        await next.resume(plan.planId, { awaitIdle: true, intent: before.delegationOrigin.pausedRunnerIntent });
        assert.equal(calls, 1, 'new owner can resume the preserved checkpoint');
        assert.equal(store.getPlan(plan.planId).runner.status, 'waiting_user');
      }
    });
  }
}
