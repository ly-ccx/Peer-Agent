import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pathOf } from './data-store.mjs';
import {
  createGoalPlanStore,
  goalPlanIsSelfDriven,
} from './goal-plan-store.mjs';
import {
  createDeterministicExplorePlan,
  createGoalRunner,
} from './goal-runner.mjs';
import {
  decideIntakeConvergence,
  shouldAutoStartAcceptedGoalRunnerFromChange,
} from './goal-intake-convergence.mjs';

const packageSourceDir = path.dirname(new URL(import.meta.url).pathname);
const desktopCompatDir = path.resolve(packageSourceDir, '../../../apps/desktop/electron/main');

test('shared Goal runtime owns store, pump, intake, and data-home behavior', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-goal-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');

  try {
    const store = createGoalPlanStore();
    const plan = store.createGoalContract({
      conversationId: 'conv-shared-goal',
      title: 'Shared Goal',
      goal: 'Use one pump in Desktop and TUI',
      tasks: [{ taskId: 't1', title: 'Verify the shared seam', status: 'pending' }],
    });

    assert.equal(path.dirname(store.getStoreDir()), process.env.PEER_AGENT_HOME);
    assert.equal(store.getStoreDir(), pathOf('goalPlans'));
    assert.equal(goalPlanIsSelfDriven(plan), true);
    assert.equal(
      shouldAutoStartAcceptedGoalRunnerFromChange({ changeKind: 'goal-accepted' }, plan),
      true,
    );
    assert.equal(
      shouldAutoStartAcceptedGoalRunnerFromChange({ changeKind: 'persist' }, plan),
      false,
    );
    assert.equal(decideIntakeConvergence(plan, { terminalStatus: 'done' }), 'skip');
    assert.equal(typeof createGoalRunner, 'function');

    const explorePlan = createDeterministicExplorePlan(plan);
    assert.equal(typeof explorePlan.requiredBeforeAct, 'boolean');
    assert.ok(Array.isArray(explorePlan.questions));
    assert.ok(Array.isArray(explorePlan.exitCriteria));
    assert.equal(typeof explorePlan.generatedAt, 'string');
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reusing an unaccepted completed Goal emits goal-accepted and allows auto-start', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-shared-goal-handoff-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');

  try {
    const events = [];
    const store = createGoalPlanStore({ onChange: (event) => events.push(event) });
    const created = store.createGoalContract({
      conversationId: 'conv-shared-unaccepted',
      title: 'Continue after handoff',
      goal: 'Continue after handoff',
      tasks: [
        { taskId: 'trace', title: 'Trace the stop', status: 'completed', evidenceRefs: ['e1'] },
        { taskId: 'fix', title: 'Fix the handoff', status: 'completed', evidenceRefs: ['e2'] },
      ],
    });
    store.setPlanStatus(created.planId, 'completed', { changedBy: 'system:test' });
    events.length = 0;

    const continued = store.upsertGoalContract(created.conversationId, {
      title: 'Continue after handoff',
      goal: 'Continue after handoff',
      tasks: [
        { taskId: 'trace', title: 'Trace the stop', status: 'completed', evidenceRefs: ['e1'] },
        { taskId: 'fix', title: 'Fix the handoff', status: 'pending', evidenceRefs: [] },
      ],
    });

    assert.equal(continued.planId, created.planId);
    assert.notEqual(continued.status, 'completed');
    assert.equal(events.at(-1)?.changeKind, 'goal-accepted');
    assert.equal(
      shouldAutoStartAcceptedGoalRunnerFromChange(events.at(-1), continued),
      true,
    );

    store.appendRunEvent(created.planId, {
      type: 'action_started',
      summary: 'Goal Runner started',
    });
    assert.equal(events.at(-1)?.changeKind, 'persist');
    assert.equal(
      shouldAutoStartAcceptedGoalRunnerFromChange(events.at(-1), store.getPlan(created.planId)),
      false,
    );
  } finally {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime-node source has no Desktop dependency and Desktop files are compatibility seams', () => {
  for (const file of [
    'data-store.mjs',
    'goal-plan-store.mjs',
    'goal-runner.mjs',
    'goal-intake-convergence.mjs',
  ]) {
    const sharedSource = readFileSync(path.join(packageSourceDir, file), 'utf8');
    const desktopSource = readFileSync(path.join(desktopCompatDir, file), 'utf8');

    assert.doesNotMatch(sharedSource, /apps\/desktop|desktop\/electron\/main/);
    assert.match(desktopSource, /from '@peer-agent\/runtime-node'/);
  }
});
