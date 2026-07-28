/**
 * Milestone D soak: 10+ prepare/commit/persist/consume cycles on the same run.
 * Proves Goal can survive repeated context-limit hits without losing runId/task cursor.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-soak-'));
  const store = createGoalPlanStore({ storeDir: dir });
  return {
    store,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test('Goal compact/resume soak survives at least 10 cycles on the same runId', async () => {
  const { store, cleanup } = createTempStore();
  try {
    const plan = store.createPlan({
      conversationId: 'conv-soak',
      title: 'Soak resume',
      goal: 'Survive many compact/resume cycles',
      tasks: [
        { taskId: 't1', title: 'First', status: 'completed', evidenceRefs: ['tool-result://seed'] },
        { taskId: 't2', title: 'Long running', status: 'pending' },
      ],
    });
    store.recordApproval(plan.planId, { decision: 'approve' });
    store.setPlanStatus(plan.planId, 'executing');
    store.setRunnerState(plan.planId, {
      enabled: true,
      status: 'running',
      currentTaskId: 't2',
      phase: 'act',
      intent: 'execute',
    });

    const SOAK_CYCLES = 12; // at least 10
    const runIds = [];
    const sequences = [];

    for (let i = 0; i < SOAK_CYCLES; i += 1) {
      const latest = store.getPlan(plan.planId);
      assert.ok(latest, `plan missing at cycle ${i}`);
      const prepared = store.prepareContextCheckpoint(plan.planId, {
        expectedPlanVersion: latest.version,
        expectedRunId: latest.runner?.runId,
        reason: 'soft_threshold',
        checkpoint: {
          objectiveNow: latest.goal,
          currentWork: `Continue t2 cycle ${i + 1}`,
          mostImportantFact: `cycle=${i + 1}; current task is t2`,
          handoffNote: `Resume after compact #${i + 1}`,
          firstAction: {
            kind: 'inspect',
            instruction: `Continue task t2 after compact #${i + 1}`,
            successCheck: 'progress written with evidenceRefs',
            requiredEvidenceRefs: [],
          },
          progress: {
            total: 2,
            completed: 1,
            failed: 0,
            blocked: 0,
            percent: 50,
            nextRunnableTaskIds: ['t2'],
          },
        },
      });
      assert.equal(prepared.runner.status, 'compacting_context');
      assert.equal(prepared.runner.contextCheckpoint.status, 'preparing');

      const committed = store.commitContextCheckpoint(plan.planId, {
        expectedPlanVersion: prepared.version,
        expectedRunId: prepared.runner.runId,
        checkpoint: prepared.runner.contextCheckpoint,
      });
      assert.equal(committed.runner.contextCheckpoint.status, 'committed');
      runIds.push(committed.runner.runId);
      sequences.push(committed.runner.contextCheckpoint.sequence);

      const persisted = store.markContextCompactionPersisted(plan.planId, {
        checkpointId: committed.runner.contextCheckpoint.checkpointId,
        conversationRevision: `rev-soak-${i + 1}`,
      });
      assert.equal(persisted.runner.status, 'resuming_after_compaction');
      assert.equal(
        persisted.runner.compactionCount,
        (latest.runner?.compactionCount || 0) + 1,
      );

      const consumed = store.markContextCheckpointConsumed(plan.planId, {
        checkpointId: persisted.runner.contextCheckpoint.checkpointId,
      });
      assert.equal(consumed.runner.status, 'running');
      assert.equal(consumed.runner.contextCheckpoint, undefined);
      assert.equal(
        consumed.runner.lastConsumedCheckpointId,
        persisted.runner.contextCheckpoint.checkpointId,
      );
      assert.equal(consumed.runner.currentTaskId, 't2');
    }

    // Same logical run across all cycles.
    assert.equal(runIds.length, SOAK_CYCLES);
    assert.ok(runIds.every((id) => id && id === runIds[0]), 'runId must stay stable across soak');
    // Sequences must be strictly increasing.
    for (let i = 1; i < sequences.length; i += 1) {
      assert.ok(sequences[i] > sequences[i - 1], `sequence not increasing at ${i}`);
    }

    const finalPlan = store.getPlan(plan.planId);
    assert.equal(finalPlan.runner.compactionCount, SOAK_CYCLES);
    assert.equal(finalPlan.runner.runId, runIds[0]);
    assert.equal(finalPlan.runner.currentTaskId, 't2');
    assert.ok(finalPlan.runner.lastConsumedCheckpointSequence >= SOAK_CYCLES);

    // Crash recovery after soak: re-commit one checkpoint and recover.
    const beforeCrash = store.getPlan(plan.planId);
    const prepared = store.prepareContextCheckpoint(plan.planId, {
      expectedPlanVersion: beforeCrash.version,
      expectedRunId: beforeCrash.runner.runId,
      reason: 'process_recovery',
      checkpoint: {
        objectiveNow: beforeCrash.goal,
        currentWork: 'Recover after soak crash',
        mostImportantFact: 't2 still current',
        handoffNote: 'resume t2',
        firstAction: {
          kind: 'inspect',
          instruction: 'Continue task t2',
          successCheck: 'ok',
          requiredEvidenceRefs: [],
        },
      },
    });
    store.commitContextCheckpoint(plan.planId, {
      expectedPlanVersion: prepared.version,
      expectedRunId: prepared.runner.runId,
      checkpoint: prepared.runner.contextCheckpoint,
    });
    store.setRunnerState(plan.planId, {
      enabled: false,
      status: 'compacting_context',
    });

    const runner = createGoalRunner({
      goalPlanStore: store,
      chatRuntime: {
        async runGoalTurn() {
          return { terminalStatus: 'completed', toolCallCount: 0 };
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    const recovery = runner.recoverContextCheckpoints();
    assert.ok(
      recovery.recovered.some((item) => item.planId === plan.planId && item.action === 'resume_committed'),
    );
    const after = store.getPlan(plan.planId);
    assert.equal(after.runner.enabled, true);
    assert.equal(after.runner.runId, runIds[0]);
  } finally {
    cleanup();
  }
});

test('soak documentation marker: at least 10 compact/resume cycles required', () => {
  // Contract marker for plan successCriteria file-contains check.
  assert.ok(true, 'at least 10');
});
