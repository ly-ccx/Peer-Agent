import { executionBindingCurrent } from './coordination-kernel.mjs';
import { workBudgetBinding } from './work-budget.mjs';

/** The task plan binds an executor; the coordination journal decides whether that binding is still current. */
export function sessionExecutionCurrent(plan) {
  const origin = plan?.delegationOrigin;
  if (origin?.cancellation) return false;
  if (['paused', 'superseded'].includes(origin?.phase)) return false;
  const control = workBudgetBinding(origin?.workspaceId)?.store.readSessionControl?.(origin?.sessionId) || origin?.executionControl;
  if (control && (control.phase !== 'settled' || control.kind === 'cancel')) return false;
  const binding = origin?.coordinationBinding;
  if (!binding) return true; // Legacy plans retain their existing enforcement, never obtain a mandate.
  const store = workBudgetBinding(origin.workspaceId)?.store;
  const state = store?.readLifecycleFacts?.() ?? store?.read();
  const mandate = state?.mandates?.[binding.workId];
  const transition = Object.values(state?.transitions || {}).find(row => row.executionEpoch === binding.executionEpoch);
  return executionBindingCurrent(mandate, transition, binding);
}
