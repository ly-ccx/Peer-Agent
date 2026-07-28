import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicGoalCheckpoint,
  computeGoalCheckpointDigest,
  formatGoalCheckpointForPrompt,
  normalizeGoalCheckpoint,
  validateGoalCheckpoint,
} from './goal-checkpoint.ts';

test('normalizeGoalCheckpoint fills required fields and stable digest', () => {
  const checkpoint = normalizeGoalCheckpoint({
    planId: 'plan-1',
    runId: 'run-1',
    currentTaskId: 'task-a',
    objectiveNow: 'Implement checkpoint resume',
    currentWork: 'Wire store APIs',
    mostImportantFact: 'Committed checkpoint is write-ahead of compaction',
    handoffNote: 'Continue store CAS then runner resume guard',
    firstAction: {
      kind: 'edit',
      instruction: 'Add commitContextCheckpoint API',
      successCheck: 'goal-plan-store exports commitContextCheckpoint',
      requiredEvidenceRefs: [],
    },
    progress: {
      total: 5,
      completed: 1,
      failed: 0,
      blocked: 0,
      percent: 20,
      nextRunnableTaskIds: ['task-a'],
    },
  });

  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.status, 'preparing');
  assert.equal(checkpoint.planId, 'plan-1');
  assert.equal(checkpoint.runId, 'run-1');
  assert.equal(checkpoint.currentTaskId, 'task-a');
  assert.ok(checkpoint.digest);
  assert.equal(
    checkpoint.digest,
    computeGoalCheckpointDigest(checkpoint),
  );
});

test('digest ignores lifecycle transitions', () => {
  const preparing = normalizeGoalCheckpoint({
    planId: 'plan-1',
    runId: 'run-1',
    objectiveNow: 'x',
    currentWork: 'y',
    mostImportantFact: 'z',
    handoffNote: 'h',
    firstAction: {
      kind: 'inspect',
      instruction: 'continue',
      successCheck: 'evidence written',
      requiredEvidenceRefs: [],
    },
  });
  const committed = normalizeGoalCheckpoint({
    ...preparing,
    status: 'committed',
    committedAt: '2026-07-28T00:00:00.000Z',
  });
  assert.equal(preparing.digest, committed.digest);
});

test('buildDeterministicGoalCheckpoint derives current task and sequence', () => {
  const plan = {
    planId: 'plan-9',
    version: 3,
    goal: 'Ship checkpoint resume',
    title: 'Checkpoint resume',
    tasks: [
      { taskId: 'done-task', title: 'Done', status: 'completed', evidenceRefs: ['e1'] },
      { taskId: 'next-task', title: 'Next work', status: 'pending' },
    ],
    runner: {
      enabled: true,
      status: 'running',
      runId: 'run-9',
      currentTaskId: 'next-task',
      lastConsumedCheckpointSequence: 2,
      turnCount: 1,
      roundCount: 1,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: 2,
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
  };

  const checkpoint = buildDeterministicGoalCheckpoint({
    plan,
    reason: 'soft_threshold',
    now: '2026-07-28T01:00:00.000Z',
  });

  assert.equal(checkpoint.sequence, 3);
  assert.equal(checkpoint.currentTaskId, 'next-task');
  assert.match(checkpoint.firstAction.instruction, /next-task/);
  assert.equal(checkpoint.progress.completed, 1);
  assert.equal(checkpoint.progress.total, 2);
});

test('formatGoalCheckpointForPrompt includes first action and resume rules', () => {
  const checkpoint = normalizeGoalCheckpoint({
    planId: 'plan-1',
    runId: 'run-1',
    status: 'committed',
    objectiveNow: 'Continue goal',
    currentWork: 'Resume task',
    mostImportantFact: 'Do not restart completed work',
    handoffNote: 'Pick up firstAction',
    mustReadEvidenceRefs: ['tool-result://abc'],
    firstAction: {
      kind: 'verify',
      instruction: 'Run store tests',
      successCheck: 'node --test goal-plan-store.test.mjs exits 0',
      requiredEvidenceRefs: ['tool-result://abc'],
    },
  });
  const prompt = formatGoalCheckpointForPrompt(checkpoint);
  assert.match(prompt, /Active Goal execution checkpoint/);
  assert.match(prompt, /First action \(verify\): Run store tests/);
  assert.match(prompt, /Must read evidence:/);
  assert.match(prompt, /tool-result:\/\/abc/);
  assert.match(prompt, /Resume rules:/);
});

test('validateGoalCheckpoint rejects missing plan/run', () => {
  const result = validateGoalCheckpoint({
    objectiveNow: 'x',
    currentWork: 'y',
    mostImportantFact: 'z',
    handoffNote: 'h',
    firstAction: {
      kind: 'inspect',
      instruction: 'continue',
      successCheck: 'ok',
      requiredEvidenceRefs: [],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});
