import {
  decideLifecycle,
  type ExecutionOwnership,
  type GoalPlanProjectionSnapshot,
  type LifecycleDecision,
  type LifecycleFacts,
} from './task-overview.ts';

export type { ExecutionOwnership, LifecycleDecision, LifecycleFacts } from './task-overview.ts';

export interface SessionFactSnapshot {
  readonly status: LifecycleDecision['status'];
  readonly verificationActive: boolean;
  readonly needsUser: boolean;
  readonly blockedReason?: string;
}

/**
 * 兼容入口：把扁平事实交给唯一的生命周期决策器。
 * 旧的直接判定逻辑已删除，`status / needsUser / blockedReason` 全部来自 `decideLifecycle`。
 */
export function deriveSessionFacts(input: {
  status?: string;
  phase?: string;
  runnerStatus?: string;
  accepted?: boolean;
  superseded?: boolean;
  needsUser?: boolean;
  blockedReason?: string;
  verificationActive?: boolean;
  interrupted?: boolean;
  delegated?: boolean;
  cancellationPhase?: string;
  takeoverPhase?: string;
  executionOwnership?: ExecutionOwnership;
}): SessionFactSnapshot {
  const snapshot = {
    conversationId: '',
    title: '',
    planId: '',
    status: (input.status ?? 'executing') as GoalPlanProjectionSnapshot['status'],
    ...(input.runnerStatus ? { runnerStatus: input.runnerStatus } : {}),
  } as GoalPlanProjectionSnapshot;
  const decision = decideLifecycle(snapshot, {
    ...(input.executionOwnership ? { executionOwnership: input.executionOwnership } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.accepted !== undefined ? { accepted: input.accepted } : {}),
    ...(input.superseded !== undefined ? { superseded: input.superseded } : {}),
    ...(input.needsUser !== undefined ? { needsUser: input.needsUser } : {}),
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    ...(input.verificationActive !== undefined ? { verificationActive: input.verificationActive } : {}),
    ...(input.interrupted !== undefined ? { interrupted: input.interrupted } : {}),
    ...(input.delegated !== undefined ? { delegated: input.delegated } : {}),
    ...(input.cancellationPhase ? { cancellationPhase: input.cancellationPhase } : {}),
    ...(input.takeoverPhase ? { takeoverPhase: input.takeoverPhase } : {}),
  });
  return {
    status: decision.status,
    verificationActive: decision.verificationActive,
    needsUser: decision.needsUser,
    ...(decision.blockedReason ? { blockedReason: decision.blockedReason } : {}),
  };
}
