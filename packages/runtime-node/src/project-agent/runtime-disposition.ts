import { runtimeSessionOwnership, runtimeSessionFacts } from '@peer-agent/protocol';
import type { ProjectWorkState, ProjectWorkReceipt, ProjectTurnEnd, RuntimeHandling } from '@peer-agent/protocol';

type Wait = ProjectWorkReceipt['waitFor'][number];
type Disposition = { readonly state: ProjectWorkState; readonly end?: ProjectTurnEnd; readonly waitFor?: readonly Wait[]; readonly blockedCode?: string };
interface Work {
  readonly state?: ProjectWorkState;
  readonly stopScope?: 'reply' | 'work';
  readonly end?: ProjectTurnEnd;
  readonly pendingControl?: unknown;
  readonly delegationFollowUp?: ProjectWorkReceipt['delegationFollowUp'];
  readonly sessionIds?: readonly string[];
}
interface Outcome {
  readonly failed?: boolean;
  readonly stopped?: boolean;
  readonly yielded?: boolean;
  readonly budgetLimited?: boolean;
  readonly deliveryPending?: boolean;
  readonly reason?: string;
  readonly silentWait?: { readonly sessionIds?: readonly string[] } | null;
}
export interface RuntimeDisposition extends Disposition {
  readonly end: ProjectTurnEnd;
  readonly waitFor: readonly Wait[];
  readonly handling: RuntimeHandling;
  readonly repairSessionIds: readonly string[];
}
interface RuntimeDispositionInput {
  readonly previous?: Work;
  readonly sessions?: readonly unknown[];
  readonly outcome?: Outcome;
  readonly continuation?: Disposition;
  readonly semantic?: Disposition | null;
  readonly reportedWait?: { readonly waitingUser: boolean; readonly sessionStates: readonly { readonly sessionId: string }[] } | null;
  readonly recovery?: { readonly reservationId?: string; readonly retryable?: boolean } | null;
  readonly unseenEvents?: boolean;
  readonly held?: boolean;
}

/** One priority order for normal completion, reply recovery and custody recovery. No effects or grants. */
export function decideRuntimeDisposition({ previous = {}, sessions = [], outcome = {}, continuation,
  semantic, reportedWait, recovery, unseenEvents = false, held = false }: RuntimeDispositionInput): RuntimeDisposition {
  const checked = sessions.map(runtimeSessionFacts);
  const missing = (previous.sessionIds || []).filter(id => !checked.some(row => row.sessionId === id));
  const ownership = runtimeSessionOwnership([...sessions, ...missing.map(sessionId => ({ sessionId }))]);
  const settlement = [...checked.filter(row => !row.valid || row.handling === 'host'
    && (['stop_unconfirmed', 'unknown_facts'].includes(row.reason) || ['stopping', 'awaiting_outcome'].includes(row.status)))
    .map(row => row.sessionId), ...missing];
  const result = (state: ProjectWorkState, end: ProjectTurnEnd, handling: RuntimeHandling, waitFor: readonly Wait[] = [], blockedCode?: string): RuntimeDisposition => ({
    state, end, handling, waitFor, repairSessionIds: ownership.repairSessionIds, ...(blockedCode ? { blockedCode } : {}),
  });
  if (held || runtimeWorkControlHeld(previous) || (!outcome.stopped && runtimeWorkHeld(previous))) {
    const state = previous.state === 'cancelled' ? 'cancelled' : previous.state === 'waiting_children' ? 'waiting_children' : 'paused';
    return result(state, 'user_stopped', previous.pendingControl ? 'host' : 'none',
      state === 'waiting_children' ? ownership.waitingSessionIds.map(id => ({ kind: 'session' as const, id })) : []);
  }
  if (outcome.stopped) {
    const waiting = ownership.waitingSessionIds;
    return result(waiting.length ? 'waiting_children' : 'paused', 'user_stopped', 'none', waiting.map(id => ({ kind: 'session' as const, id })));
  }
  if (outcome.budgetLimited) return result('budget_limited', 'budget_limited', 'host');
  if (outcome.failed) return recovery?.reservationId
    ? result('retry_wait', 'provider_retryable', 'host', [{ kind: 'retry_timer', id: recovery.reservationId }])
    : result('blocked_system', outcome.reason === 'agent_no_progress' ? 'no_progress' : 'fatal', 'host');
  if (outcome.deliveryPending) return result('retry_wait', 'provider_retryable', 'host');
  if (checked.some(row => !row.sessionId)) return result('blocked_system', 'fatal', 'host', [], 'runtime_session_invalid');
  if (outcome.silentWait) return result(ownership.needsUser ? 'waiting_user' : 'waiting_children',
    ownership.needsUser ? 'awaiting_user' : 'awaiting_children', ownership.needsUser ? 'user' : 'host',
    (outcome.silentWait.sessionIds || ownership.waitingSessionIds).map(id => ({ kind: 'session' as const, id })));
  if (reportedWait) return result(reportedWait.waitingUser ? 'waiting_user' : 'waiting_children',
    reportedWait.waitingUser ? 'awaiting_user' : 'awaiting_children', reportedWait.waitingUser ? 'user' : 'host',
    reportedWait.sessionStates.map(row => ({ kind: 'session' as const, id: row.sessionId })));
  if (settlement.length) return result('waiting_children', 'awaiting_children', 'host', settlement.map(id => ({ kind: 'session' as const, id })));
  if (continuation?.state === 'blocked_system') return result('blocked_system', continuation.end || 'no_progress', 'host');
  if (previous.delegationFollowUp?.blockers.length && !ownership.needsUser) return previous.delegationFollowUp.blockers.every(row => row.retryable)
    ? result('runnable', 'yielded', 'model') : result('blocked_system', 'fatal', 'host');
  if (semantic) {
    const handling: RuntimeHandling = semantic.state === 'runnable' ? 'model' : semantic.state === 'waiting_user' ? 'user'
      : ['delivered', 'cancelled', 'paused'].includes(semantic.state) ? 'none' : 'host';
    return result(semantic.state, semantic.end || 'yielded', handling, semantic.waitFor || [], semantic.blockedCode);
  }
  if (unseenEvents && !ownership.needsUser) return result('runnable', 'yielded', 'model');
  if (outcome.yielded) return result('runnable', 'yielded', 'model');
  if (ownership.repairSessionIds.length) return result('runnable', 'yielded', 'model');
  if (ownership.needsUser) return result('waiting_user', 'awaiting_user', 'user');
  if (ownership.hostSessionIds.length) return result('waiting_children', 'awaiting_children', 'host',
    ownership.hostSessionIds.map(id => ({ kind: 'session' as const, id })));
  return result('delivered', 'reply_committed', 'none');
}

export function runtimeWorkControlHeld(work: Work | null | undefined): boolean {
  return Boolean(work?.pendingControl || work?.stopScope === 'work'
    && (['paused', 'cancelled'].includes(work.state || '') || work.end === 'user_stopped'));
}

/** A stopped reply remains closed while host settlement or child work proceeds. */
export function runtimeWorkHeld(work: Work | null | undefined): boolean {
  return runtimeWorkControlHeld(work) || work?.end === 'user_stopped';
}
