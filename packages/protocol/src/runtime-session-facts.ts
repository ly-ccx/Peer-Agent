import { WORK_SESSION_STATUSES, type WorkSessionStatus } from './delegation.ts';
import { decideFollowUp, type ExecutionOwnership, type FollowUpOwner, type FollowUpReason } from './task-overview.ts';

export type RuntimeHandling = 'model' | 'host' | 'user' | 'none';

/** A checked view of existing session facts, never a second lifecycle or execution receipt. */
export interface RuntimeSessionFacts {
  readonly sessionId: string;
  readonly status: WorkSessionStatus | 'unknown';
  readonly valid: boolean;
  readonly executionOwnership: ExecutionOwnership;
  readonly owner: FollowUpOwner;
  readonly reason: string;
  readonly handling: RuntimeHandling;
  readonly pendingManaged: boolean;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const statuses: ReadonlySet<string> = new Set(WORK_SESSION_STATUSES);
const ownerships: ReadonlySet<unknown> = new Set(['live', 'ended', 'unknown']);
const owners: ReadonlySet<unknown> = new Set(['bot', 'user', 'none']);
const reasons: ReadonlySet<unknown> = new Set<FollowUpReason>(['settled', 'superseded', 'stop_confirmed', 'user_withdrawn',
  'stop_unconfirmed', 'human_request', 'awaiting_human_gate', 'technical_block', 'awaiting_acceptance_technical',
  'verification_failed', 'live_execution', 'paused', 'unknown_facts']);
const hostReasons = new Set(['live_execution', 'stop_unconfirmed', 'unknown_facts']);

export function runtimeSessionFacts(value: unknown): RuntimeSessionFacts {
  const row = record(value), origin = record(row.origin), cancellation = record(origin.cancellation);
  const sessionId = text(row.sessionId), rawStatus = text(row.status);
  const status: RuntimeSessionFacts['status'] = statuses.has(rawStatus) ? rawStatus as WorkSessionStatus : 'unknown';
  const executionOwnership: ExecutionOwnership = ownerships.has(row.executionOwnership)
    ? row.executionOwnership as ExecutionOwnership : 'unknown';
  const declared = row.followUp === undefined ? null : record(row.followUp);
  const valid = Boolean(sessionId) && status !== 'unknown'
    && (row.executionOwnership === undefined || ownerships.has(row.executionOwnership))
    && (!declared || owners.has(declared.owner) && reasons.has(declared.reason))
    && ['resultConfirmationRequired', 'completionReviewRequired'].every(key => row[key] === undefined || typeof row[key] === 'boolean')
    && (row.needsUser === undefined || typeof row.needsUser === 'boolean' || Array.isArray(row.needsUser));
  const human = row.resultConfirmationRequired === true || row.completionReviewRequired === true
    || row.needsUser === true || Array.isArray(row.needsUser) && row.needsUser.length > 0;
  const fallback = status === 'unknown' ? null : decideFollowUp({ status }, {
    accepted: status === 'accepted', humanGate: row.resultConfirmationRequired === true,
    ...(typeof cancellation.phase === 'string' ? { cancellationPhase: cancellation.phase } : {}),
    ...(cancellation.disposition === 'user_withdrawn' ? { cancellationDisposition: 'user_withdrawn' as const } : {}),
  }, executionOwnership);
  const owner: FollowUpOwner = declared && owners.has(declared.owner) ? declared.owner as FollowUpOwner : fallback?.owner || 'bot';
  const reason = text(declared?.reason) || fallback?.reason || 'unknown_facts';
  const stopping = ['stopping', 'awaiting_outcome'].includes(status)
    || status === 'cancelled' && owner !== 'none';
  const handling: RuntimeHandling = !valid ? 'host' : human || owner === 'user' ? 'user'
    : executionOwnership === 'live' || stopping || owner === 'bot' && hostReasons.has(reason) ? 'host'
    : owner === 'none' ? 'none' : 'model';
  return { sessionId, status, valid, executionOwnership, owner, reason, handling,
    pendingManaged: handling === 'host' || handling === 'user' || !['accepted', 'cancelled'].includes(status) };
}

/** Missing/invalid facts remain obligations; a valid public terminal does not invent live ownership. */
export function hasPendingRuntimeSessions(sessions: readonly unknown[], expectedIds: readonly string[] = []): boolean {
  return sessions.some(session => runtimeSessionFacts(session).pendingManaged)
    || expectedIds.some(id => !sessions.some(session => record(session).sessionId === id));
}

export interface RuntimeSessionOwnership {
  readonly repairSessionIds: readonly string[];
  readonly hostSessionIds: readonly string[];
  readonly waitingSessionIds: readonly string[];
  readonly needsUser: boolean;
}

export function runtimeSessionOwnership(sessions: readonly unknown[]): RuntimeSessionOwnership {
  const facts = sessions.map(runtimeSessionFacts);
  return {
    repairSessionIds: facts.filter(row => row.handling === 'model').map(row => row.sessionId),
    hostSessionIds: facts.filter(row => row.handling === 'host').map(row => row.sessionId),
    waitingSessionIds: facts.filter(row => row.handling === 'host'
      && (row.executionOwnership === 'live' || row.reason === 'live_execution')).map(row => row.sessionId),
    needsUser: facts.some(row => row.handling === 'user'),
  };
}

export interface ResourceWaitScope {
  readonly workspaceId: string;
  readonly parentConversationId: string;
  readonly workId: string;
  readonly sessionIds: readonly string[];
  readonly executionBindings?: Readonly<Record<string, { readonly executionEpoch: string; readonly goalRevision: number }>>;
}
export interface ResourceWaitReference {
  readonly kind: 'resource';
  readonly id: string;
  readonly revision: string;
}
export interface ResourceWaitFact {
  readonly sessionId: string;
  readonly wait: ResourceWaitReference;
  readonly reason: string;
}
export type ResourceWaitInspection =
  | { readonly state: 'waiting'; readonly current: ResourceWaitFact }
  | { readonly state: 'ready'; readonly sessionId: string }
  | { readonly state: 'stale' | 'unavailable'; readonly reason: string };
export interface ResourceWaitPort {
  readonly read: (scope: ResourceWaitScope) => readonly ResourceWaitFact[];
  readonly inspect: (scope: ResourceWaitScope, wait: ResourceWaitReference) => ResourceWaitInspection;
}
