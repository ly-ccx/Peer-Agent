// Goal execution checkpoint Source.
//
// After context compaction, inject the committed GoalExecutionCheckpoint so the
// model resumes the same run/task instead of guessing from free-text summary.
//
// Governance:
// - Factual runtime state (L7_CONTINUITY / trust=runtime), not user instructions.
// - Only committed checkpoints are injected.
// - Digest / planId / runId must validate; stale or invalid records are ignored.
// - Reads goalPlanStore only; never writes.

// Relative import keeps this package testable without a full workspace install
// while still sharing the canonical checkpoint helpers from runtime-core.
import {
  validateGoalCheckpoint,
  formatGoalCheckpointForPrompt,
} from '../../../runtime-core/dist/index.js';

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readActivePlan(input = {}) {
  const store = input.goalPlanStore;
  const conversationId = input.conversationId ?? null;
  if (!store || typeof store.getActivePlanByConversation !== 'function') {
    return null;
  }
  try {
    return store.getActivePlanByConversation(conversationId) || null;
  } catch {
    return null;
  }
}

function selectCommittedCheckpoint(plan) {
  const checkpoint = plan?.runner?.contextCheckpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const validation = validateGoalCheckpoint(checkpoint);
  if (!validation.ok || !validation.checkpoint) return null;
  const cp = validation.checkpoint;
  if (cp.status !== 'committed') return null;
  if (cp.planId && plan.planId && cp.planId !== plan.planId) return null;
  if (cp.runId && plan.runner?.runId && cp.runId !== plan.runner.runId) return null;
  const lastSeq = Number.isFinite(plan.runner?.lastConsumedCheckpointSequence)
    ? Math.trunc(plan.runner.lastConsumedCheckpointSequence)
    : 0;
  if (Number.isFinite(cp.sequence) && cp.sequence <= lastSeq) return null;
  return cp;
}

export function createGoalCheckpointPromptSource() {
  return {
    id: 'runtime.goal-checkpoint',
    layer: 'L7_CONTINUITY',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = asString(input.mode) || 'chat';
      if (mode !== 'goal' && mode !== 'chat') {
        return { checkpoint: null, planId: null };
      }
      const plan = readActivePlan(input);
      if (!plan) return { checkpoint: null, planId: null };
      return {
        checkpoint: selectCommittedCheckpoint(plan),
        planId: plan.planId || null,
        runId: plan.runner?.runId || null,
      };
    },
    render(observation) {
      const checkpoint = observation?.checkpoint;
      if (!checkpoint) return [];
      const content = formatGoalCheckpointForPrompt(checkpoint);
      if (!content) return [];
      return [
        {
          id: 'runtime.goal-checkpoint.facts',
          layer: 'L7_CONTINUITY',
          priority: 1,
          title: 'Active Goal execution checkpoint',
          content,
          source: {
            id: 'runtime.goal-checkpoint',
            kind: 'goal-checkpoint',
            planId: checkpoint.planId,
            runId: checkpoint.runId,
            checkpointId: checkpoint.checkpointId,
            sequence: checkpoint.sequence,
            digest: checkpoint.digest,
            status: checkpoint.status,
          },
          trust: 'runtime',
        },
      ];
    },
  };
}
