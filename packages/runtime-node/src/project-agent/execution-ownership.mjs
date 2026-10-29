import { executionBindingCurrent } from './coordination-kernel.mjs';
import { workBudgetBinding } from './work-budget.mjs';

/** The task plan binds an executor; the coordination journal decides whether that binding is still current. */
export function sessionExecutionCurrent(plan) {
  const origin = plan?.delegationOrigin;
  if (origin?.cancellation) return false;
  const binding = origin?.coordinationBinding;
  if (!binding) return true; // Legacy plans retain their existing enforcement, never obtain a mandate.
  const state = workBudgetBinding(origin.workspaceId)?.store.read();
  const mandate = state?.mandates?.[binding.workId];
  const transition = Object.values(state?.transitions || {}).find(row => row.executionEpoch === binding.executionEpoch);
  return executionBindingCurrent(mandate, transition, binding);
}
