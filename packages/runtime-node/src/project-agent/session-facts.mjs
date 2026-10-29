import { deriveSessionFacts } from '@peer-agent/protocol';

// Execution ownership is process-local. A stale persisted flag cannot prove a live verifier after restart.
const attempts = new Map();
const executions = new Map();

export function beginVerificationAttempt(planId, attemptId) {
  const token = { attemptId };
  const active = attempts.get(planId) || new Set();
  active.add(token); attempts.set(planId, active);
  return () => {
    active.delete(token);
    if (!active.size && attempts.get(planId) === active) attempts.delete(planId);
  };
}

/**
 * 登记一次真实执行（ProjectAgentRunner 的 runJob）。
 * token 只活在进程内，finally 释放；暂停、取消、异常、重入都走同一条释放路径。
 * 不做持久化，重启后自然为空 —— 空不等于"已结束"，只等于"没有活体证据"。
 */
export function beginExecutionAttempt(conversationId, attemptId) {
  const key = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!key) return () => {};
  const token = { attemptId };
  const active = executions.get(key) || new Set();
  active.add(token); executions.set(key, active);
  return () => {
    active.delete(token);
    if (!active.size && executions.get(key) === active) executions.delete(key);
  };
}

export function conversationExecutionLive(conversationId) {
  const key = typeof conversationId === 'string' ? conversationId.trim() : '';
  return Boolean(key) && executions.has(key);
}

/** runner 自己写下的终态，才能把"没有 token"解释成执行已结束。 */
const ENDED_RUNNER_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

/**
 * runtime → protocol 的执行所有权事实：live / ended / unknown。
 * - live 只来自本进程持有的执行 token（runner 轮次或核验尝试）；
 * - ended 只来自 runner 落盘的终态；
 * - 其余（含重启后遗留的 runner.status='running'）一律 unknown，既不冒充活体，也不冒充已结束。
 */
export function executionOwnershipOf(plan) {
  if (plan?.planId && attempts.has(plan.planId)) return 'live';
  if (conversationExecutionLive(plan?.conversationId)) return 'live';
  const runnerStatus = plan?.runner?.status;
  if (typeof runnerStatus === 'string' && ENDED_RUNNER_STATUSES.has(runnerStatus)) return 'ended';
  return 'unknown';
}

export function sessionFactsFromPlan(plan) {
  const verificationActive = attempts.has(plan?.planId);
  const executionOwnership = executionOwnershipOf(plan);
  return { ...deriveSessionFacts({ status: plan?.status, runnerStatus: plan?.runner?.status,
    phase: plan?.delegationOrigin?.phase, superseded: Boolean(plan?.delegationOrigin?.supersededBy),
    cancellationPhase: plan?.delegationOrigin?.cancellation?.phase, takeoverPhase: plan?.delegationOrigin?.takeover?.phase,
    accepted: Boolean(plan?.resultAcceptance?.acceptedAt),
    needsUser: plan?.delegationOrigin?.phase === 'awaiting_approval' || plan?.status === 'awaiting_approval'
      || plan?.runner?.waitingOnUser === true && plan?.runner?.status !== 'paused' && !plan?.delegationOrigin?.supersededBy
      || plan?.runner?.status === 'blocked' && plan?.runner?.blockedReason === 'manual_dod_confirmation_required',
    blockedReason: plan?.delegationOrigin?.agentWaitMessageId && plan?.runner?.status !== 'waiting_user'
      ? 'waiting_parent_agent' : plan?.runner?.blockedReason,
    interrupted: Boolean(plan?.runner?.interruption),
    interruptionOrigin: plan?.runner?.interruption?.origin,
    verificationActive,
    executionOwnership,
  }), verificationActive, executionOwnership };
}
