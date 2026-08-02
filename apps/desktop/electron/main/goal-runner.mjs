// Compatibility seam for Desktop-local imports.
// Desktop and TUI share the single GoalPlan pump from @peer-agent/runtime-node.
export {
  computePlanScopeSnapshot,
  computeReanchorInterval,
  createDeterministicExplorePlan,
  createGoalRunner,
  detectPlanDrift,
  evaluateVerificationGate,
  shouldReanchor,
} from '@peer-agent/runtime-node';
