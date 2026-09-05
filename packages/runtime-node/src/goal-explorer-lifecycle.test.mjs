import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

// Outcome × pool width: observe persisted state at the actual execution boundary.
for (const outcome of ['completed', 'failed', 'paused', 'cancelled']) {
  for (const concurrency of [1, 2]) {
    test(`${outcome} × concurrency ${concurrency}: only dequeued explorers start`, async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'explorer-lifecycle-'));
      const previous = process.env.PEER_AGENT_HOME;
      process.env.PEER_AGENT_HOME = home;
      try {
        const notifications = [];
        const store = createGoalPlanStore({ onChange: (event) => notifications.push(structuredClone({
          ...event, runner: event.runner ?? store.getPlan(event.planId)?.runner,
        })) });
        const plan = store.createPlan({
          conversationId: 'lifecycle', title: 'Observe explorers', goal: 'Observe state',
          tasks: [{ taskId: 't1', title: 'Investigate', status: 'pending', evidenceRefs: [] }],
        });
        store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
        const starts = [];
        let calls = 0;
        let active = 0;
        const assertionErrors = [];
        const runner = createGoalRunner({
          goalPlanStore: store,
          logger: { warn() {} },
          emitEvent(event) {
            if (event.type === 'goalRunner:explorerStarted') starts.push(event);
          },
          chatRuntime: {
            async runGoalTurn({ turnNumber }) {
              if (turnNumber === 1) return {
                intent: 'explore',
                explorers: [1, 2, 3].map((n) => ({ question: `Question ${n}`, reason: 'Inspect lifecycle' })),
              };
              return { continue: false, intent: 'verify' };
            },
          },
          explorerRunner: {
            async runExplorer({ explorer }) {
              calls++;
              active++;
              try {
              assert.equal(explorer.status, 'running');
              const states = notifications.flatMap((event) => (event.runner?.explorers ?? [])
                .filter((run) => run.explorerId === explorer.explorerId).map((run) => run.status));
              assert.ok(states.includes('queued'), 'queued must be observable');
              assert.equal(states.at(-1), 'running', 'running notification must arrive before execution');
              const runs = store.getPlan(plan.planId).runner.explorers;
              assert.equal(runs.find((r) => r.explorerId === explorer.explorerId).status, 'running');
              assert.equal(starts.length, calls, 'started event must not precede dequeue');
              assert.ok(runs.filter((r) => r.status === 'running').length <= concurrency);
              if (calls === 1) assert.equal(runs.filter((r) => r.status === 'queued').length, 2);
              } catch (error) { assertionErrors.push(error); }
              if (outcome === 'paused') runner.pause(plan.planId, 'test pause');
              if (outcome === 'cancelled') runner.clear(plan.planId, 'test cancel');
              await new Promise((resolve) => setImmediate(resolve));
              active--;
              if (outcome === 'failed') throw new Error('test failure');
              return {
                summary: 'Inspected', findings: [{ claim: 'Observed', evidenceRefs: ['tool-result://observed'] }],
                evidenceRefs: ['tool-result://observed'], allowedEvidenceRefs: ['tool-result://observed'], confidence: 'high',
              };
            },
          },
        });
        await runner.start(plan.planId, { explorerConcurrency: concurrency, maxTurns: 2, awaitIdle: true });
        const result = store.getPlan(plan.planId);
        if (assertionErrors.length) throw assertionErrors[0];
        assert.equal(active, 0);
        if (outcome === 'paused') {
          assert.equal(calls, 1, 'pause must prevent remaining dequeue');
          assert.equal(result.runner.status, 'paused');
        } else if (outcome === 'cancelled') {
          assert.equal(calls, 1, 'cancel must prevent remaining dequeue');
          assert.equal(result.status, 'cancelled');
          assert.equal(result.runner.enabled, false);
          assert.equal(result.runner.status, 'idle');
        } else {
          assert.equal(calls, 3);
          assert.ok(result.runner.explorers.every((r) => r.status === outcome));
        }
      } finally {
        if (previous === undefined) delete process.env.PEER_AGENT_HOME;
        else process.env.PEER_AGENT_HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
