import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

test('计划失败时通知 onPlanTerminal', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'goal-terminal-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = home;
  try {
    const store = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
    const plan = store.createPlan({
      conversationId: 'terminal-hook',
      title: 'Fail fast',
      goal: 'Fail fast',
      tasks: [{ taskId: 'only', title: 'only', status: 'pending', evidenceRefs: [] }],
    });
    store.promoteIntakeToGoal(plan.planId);
    store.setRunnerState(plan.planId, {
      enabled: true,
      status: 'running',
      phase: 'act',
      intent: 'execute',
      turnCount: 0,
    });
    const seen = [];
    const runner = createGoalRunner({
      goalPlanStore: store,
      logger: { info() {}, warn() {}, error() {} },
      maxRecoverableInterruptionRetries: 0,
      chatRuntime: {
        async runGoalTurn() {
          return { failed: true, failureReason: 'boom' };
        },
      },
    });
    runner.setOnPlanTerminal((event) => { seen.push(event); });
    await runner.resume(plan.planId, { awaitIdle: true, reason: 'goal_accepted' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'goalRunner:failed');
    assert.equal(seen[0].planId, plan.planId);
    assert.equal(['failed', 'interrupted'].includes(store.getPlan(plan.planId).status), true);
  } finally {
    if (previous === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
