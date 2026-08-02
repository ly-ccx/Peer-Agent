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
