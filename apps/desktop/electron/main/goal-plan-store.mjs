// Compatibility seam for Desktop-local imports.
// GoalPlan persistence and status rules are owned by @peer-agent/runtime-node.
export {
  aggregateProgress,
  applyGoalTimingTransition,
  createGoalPlanStore,
  derivePlanStatus,
  goalPlanIsSelfDriven,
  goalPlanRequiresApproval,
  normalizeGoalTiming,
} from '@peer-agent/runtime-node';
