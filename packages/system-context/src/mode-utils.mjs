// Shared mode helpers for Agent-default migration.
// Product default is Agent; wire may still be "chat" or legacy "goal".
// Design: peer-knowledge/design/product/agent-mode-default-and-adaptive-planning.md

/**
 * Self-driven kernel modes: Agent (wire chat) + legacy goal.
 * Plan stays approval-gated and is NOT self-driven.
 */
export function isSelfDrivenMode(mode) {
  return mode === 'chat' || mode === 'goal';
}

/**
 * Modes that may create/update formal GoalPlan scaffolding.
 * Includes Plan (approval workflow) and self-driven Agent/goal.
 */
export function isGoalPlanMode(mode) {
  return mode === 'plan' || isSelfDrivenMode(mode);
}

/**
 * Product-facing label for a wire mode value.
 */
export function productModeLabel(mode) {
  if (mode === 'chat' || mode === 'goal') return 'Agent';
  if (mode === 'plan') return 'Plan';
  return typeof mode === 'string' && mode.trim() ? mode.trim() : 'Agent';
}
