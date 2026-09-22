import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

// Existing explicit/accepted-goal resume × original lifecycle × next turn outcome.
for (const source of ['explicit_resume', 'goal_accepted_rearm']) {
  for (const status of ['interrupted', 'failed']) {
    for (const outcome of ['done', 'error', 'paused', 'cancelled']) {
      test(`${source} × ${status} × ${outcome}: consume interruption before execution`, async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'goal-resume-'));
        const previous = process.env.PEER_AGENT_HOME;
        process.env.PEER_AGENT_HOME = home;
        try {
          const store = createGoalPlanStore();
          const plan = store.createPlan({
            conversationId: 'resume', title: 'Resume the same task', goal: 'Resume the same task',
            tasks: [{ taskId: 'work', title: 'Continue work', status: 'pending', evidenceRefs: [] }],
          });
          store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
          store.setRunnerState(plan.planId, {
            enabled: true, status: 'failed', phase: 'act', intent: 'execute',
            interruption: { source: 'stream_error', reason: 'old connection lost', interruptedAt: '2026-09-05T10:00:00.000Z', recoverable: false },
          });
          store.appendRunEvent(plan.planId, { type: 'network_interrupted', summary: 'old connection lost', evidenceRefs: ['tool-result://old-error'] });
          store.setPlanStatus(plan.planId, status);
          const observed = [];
          let calls = 0;
          const runner = createGoalRunner({
            goalPlanStore: store, logger: { warn() {} }, recoverableRetryLimit: 0,
            chatRuntime: { async runGoalTurn() {
              calls++;
              const current = store.getPlan(plan.planId);
              observed.push({ status: current.status, interruption: current.runner.interruption });
              // This persist used to re-derive interrupted even while the next turn was running.
              store.recordTaskEvidence(plan.planId, 'work', { status: 'running', evidenceRefs: ['tool-result://resumed-work'] });
              observed.push({ status: store.getPlan(plan.planId).status, interruption: store.getPlan(plan.planId).runner.interruption });
              if (outcome === 'done') store.recordTaskEvidence(plan.planId, 'work', { status: 'completed', evidenceRefs: ['tool-result://completed-work'] });
              if (outcome === 'paused') runner.pause(plan.planId, 'user paused');
              if (outcome === 'cancelled') runner.clear(plan.planId, 'user cancelled');
              return outcome === 'error'
                ? { terminalStatus: 'error', failed: true, failureReason: 'new connection lost' }
                : { terminalStatus: 'done', continue: false };
            } },
          });
          await runner.resume(plan.planId, { awaitIdle: true, reason: source });
          assert.equal(calls, 1);
          assert.deepEqual(observed, [
            { status: 'executing', interruption: undefined },
            { status: 'executing', interruption: undefined },
          ]);
          const final = store.getPlan(plan.planId);
          assert.ok(final.runTrace.events.some(e => e.summary === 'old connection lost'));
          if (outcome === 'paused' || outcome === 'cancelled') assert.equal(final.status, outcome);
          if (outcome === 'error') assert.notEqual(final.runner.interruption?.reason, 'old connection lost');
        } finally {
          if (previous === undefined) delete process.env.PEER_AGENT_HOME;
          else process.env.PEER_AGENT_HOME = previous;
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
}

// Recovery status × caller intent: defaults execute; an explicit verify intent wins.
for (const status of ['interrupted', 'failed']) {
  for (const intent of [undefined, 'verify']) {
    test(`resume intent: ${status} × ${intent ?? 'default'}`, async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'goal-resume-intent-'));
      const previous = process.env.PEER_AGENT_HOME;
      process.env.PEER_AGENT_HOME = home;
      try {
        const store = createGoalPlanStore();
        const plan = store.createPlan({
          conversationId: 'resume-intent', title: 'Resume work', goal: 'Resume work',
          tasks: [{ taskId: 'work', title: 'Continue work', status: 'pending', evidenceRefs: [] }],
        });
        store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
        store.setRunnerState(plan.planId, {
          enabled: true, status: 'failed', phase: 'blocked', intent: 'block', lastError: 'old error',
          ...(status === 'interrupted' ? {
            interruption: { source: 'stream_error', reason: 'old error', interruptedAt: '2026-09-05T10:00:00.000Z', recoverable: false },
          } : {}),
        });
        store.appendRunEvent(plan.planId, { type: 'network_interrupted', summary: 'old error' });
        store.setPlanStatus(plan.planId, status);
        assert.equal(store.getPlan(plan.planId).status, status);
        let observed;
        const runner = createGoalRunner({
          goalPlanStore: store, logger: { warn() {} },
          chatRuntime: { async runGoalTurn() {
            const current = store.getPlan(plan.planId);
            observed = { status: current.status, intent: current.runner.intent, interruption: current.runner.interruption, lastError: current.runner.lastError };
            return { terminalStatus: 'done', continue: false };
          } },
        });
        await runner.resume(plan.planId, { awaitIdle: true, ...(intent ? { intent } : {}) });
        assert.deepEqual(observed, { status: 'executing', intent: intent ?? 'execute', interruption: undefined, lastError: undefined });
        assert.ok(store.getPlan(plan.planId).runTrace.events.some(event => event.summary === 'old error'));
      } finally {
        if (previous === undefined) delete process.env.PEER_AGENT_HOME;
        else process.env.PEER_AGENT_HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

test('Desktop accepted-goal handoff uses the shared recovery predicate, not a failed-only branch', () => {
  const main = readFileSync(new URL('../../../apps/desktop/electron/main/main.mjs', import.meta.url), 'utf8');
  const handoff = main.slice(main.indexOf('function maybeAutoStartAcceptedGoalFromPlanChange'), main.indexOf('function convergeIntakeAfterGoalTurn'));
  assert.doesNotMatch(handoff, /const isFailedRearm = plan\.status === 'failed'/);
  assert.match(handoff, /startRunner: \(\) => \(shouldRearmFailedGoalPlanFromChange\(goalPlanStore\.getPlan\?\.\(plan\.planId\)\)/);
});
