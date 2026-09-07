import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import {
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRearmFailedGoalPlanFromChange,
} from '../../../../packages/runtime-node/src/goal-intake-convergence.mjs';

// Execute the real Desktop composition function without booting Electron.
// Dependencies are injected; the function body is not reproduced in this test.
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const start = main.indexOf('function maybeAutoStartAcceptedGoalFromPlanChange(');
const end = main.indexOf('\nfunction convergeIntakeAfterGoalTurn(', start);
assert.ok(start >= 0 && end > start);
const source = main.slice(start, end);

function fixture(status) {
  let plan = { planId: 'p', conversationId: 'c', workflowKind: 'goal_self_driven',
    activation: { kind: 'accepted_goal' }, status,
    runner: { enabled: true, status: status === 'executing' ? 'running' : 'failed' } };
  const calls = [];
  const errors = [];
  let release;
  let handoff;
  const released = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    goalPlanStore: { getPlan: id => id === 'p' ? plan : null },
    goalRunner: {
      start: id => { calls.push(['start', id]); },
      resume: (id, options) => { calls.push(['resume', id, options.reason]); },
    },
    llmChatService: { forceCompleteConversationStreams: (id, options) => {
      calls.push(['release-request', id, options.reason]);
      return { released };
    } },
    shouldAutoStartAcceptedGoalRunner,
    shouldAutoStartAcceptedGoalRunnerFromChange,
    shouldRearmFailedGoalPlanFromChange,
    serializeAcceptedGoalRunnerHandoff: options => {
      handoff = serializeAcceptedGoalRunnerHandoff(options);
      return handoff;
    },
    console: { error: (...args) => { errors.push(args); } },
  });
  vm.runInContext(source, context);
  return {
    calls, errors,
    invoke: changeKind => context.maybeAutoStartAcceptedGoalFromPlanChange({ planId: 'p', changeKind }),
    change: next => { plan = next === 'missing' ? null : { ...plan, status: next,
      runner: { enabled: true, status: next === 'executing' ? 'running' : next === 'interrupted' ? 'failed' : next } }; },
    release: async () => { release(); await handoff; },
  };
}

for (const initial of ['executing', 'failed', 'interrupted']) {
  for (const latest of ['executing', 'failed', 'interrupted', 'paused', 'cancelled', 'waiting_user', 'missing']) {
    test(`Desktop goal-accepted: ${initial} → ${latest} while awaiting foreground release`, async () => {
      const f = fixture(initial);
      f.invoke('goal-accepted');
      await Promise.resolve();
      assert.deepEqual(f.calls, [['release-request', 'c', 'goal_handoff']], 'UI completion must not start another turn');
      f.change(latest);
      await f.release();
      const expected = latest === 'executing' ? [['start', 'p']]
        : ['failed', 'interrupted'].includes(latest) ? [['resume', 'p', 'goal_accepted_rearm']] : [];
      assert.deepEqual(f.calls.slice(1), expected);
      assert.deepEqual(f.errors, []);
    });
  }
  for (const change of ['runner-progress', 'runner-state', 'task-evidence']) {
    test(`Desktop ${initial}: ${change} cannot trigger automatic output`, async () => {
      const f = fixture(initial);
      f.invoke(change);
      await f.release();
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.errors, []);
    });
  }
}
