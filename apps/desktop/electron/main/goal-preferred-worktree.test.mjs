import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationPrefersWorktree,
  preparePlanExecutionWorkspace,
} from './goal-preferred-worktree.mjs';

function boundPlan(overrides = {}) {
  return {
    planId: 'plan-1',
    status: 'executing',
    activation: { kind: 'accepted_goal' },
    conversationId: 'conv-1',
    deliveryBinding: {
      executionIsolation: 'none',
      taskBranch: 'PeerAgent/demo',
      targetBranch: 'main',
      targetBranchSource: 'workspace_head',
      targetWorkspacePath: '/repo',
    },
    ...overrides,
  };
}

test('conversationPrefersWorktree is opt-in only', () => {
  assert.equal(conversationPrefersWorktree(null), false);
  assert.equal(conversationPrefersWorktree({}), false);
  assert.equal(conversationPrefersWorktree({ preferredExecutionIsolation: 'none' }), false);
  assert.equal(conversationPrefersWorktree({ preferredExecutionIsolation: 'worktree' }), true);
});

test('preparePlanExecutionWorkspace isolates only when the conversation opted in', async () => {
  const isolated = boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      worktreePath: '/tmp/worktree',
    },
  });
  let isolateCalls = 0;
  let prepareCalls = 0;
  const next = await preparePlanExecutionWorkspace({
    plan: boundPlan(),
    conversation: { preferredExecutionIsolation: 'worktree' },
    ensureTaskBranch: (plan) => plan,
    prepareForPlan: () => {
      prepareCalls += 1;
      throw new Error('prepareForPlan should not run after preferred isolate');
    },
    isolatePlan: async (plan) => {
      isolateCalls += 1;
      assert.equal(plan.planId, 'plan-1');
      return { ok: true, plan: isolated };
    },
  });
  assert.equal(isolateCalls, 1);
  assert.equal(prepareCalls, 0);
  assert.equal(next.deliveryBinding.executionIsolation, 'worktree');
});

test('unchecked conversations still use prepareForPlan for already-declared worktrees', async () => {
  let isolateCalls = 0;
  let prepareCalls = 0;
  const already = boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
    },
  });
  const next = await preparePlanExecutionWorkspace({
    plan: already,
    conversation: { preferredExecutionIsolation: 'none' },
    isolatePlan: async () => {
      isolateCalls += 1;
      return { ok: false, reason: 'should_not_run', plan: already };
    },
    prepareForPlan: async (plan) => {
      prepareCalls += 1;
      return plan;
    },
  });
  assert.equal(isolateCalls, 0);
  assert.equal(prepareCalls, 1);
  assert.equal(next, already);
});

test('intake and unbound plans stay quiet and do not pretend to isolate', async () => {
  const warnings = [];
  const intake = boundPlan({ activation: { kind: 'intake' } });
  const next = await preparePlanExecutionWorkspace({
    plan: intake,
    conversation: { preferredExecutionIsolation: 'worktree' },
    isolatePlan: async (plan) => ({ ok: false, reason: 'intake', plan }),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal(next, intake);
  assert.equal(warnings.length, 0);
});

test('dirty checkout is not auto-stashed and is reported', async () => {
  const warnings = [];
  const plan = boundPlan();
  const next = await preparePlanExecutionWorkspace({
    plan,
    conversation: { preferredExecutionIsolation: 'worktree' },
    isolatePlan: async (current) => ({ ok: false, reason: 'task_checkout_dirty', plan: current }),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal(next, plan);
  assert.match(warnings[0] ?? '', /task_checkout_dirty/);
});
