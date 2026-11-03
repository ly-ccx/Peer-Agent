import { createHash } from 'node:crypto';
import type { ResourceWaitFact, ResourceWaitInspection, ResourceWaitPort, ResourceWaitReference, ResourceWaitScope } from '@peer-agent/protocol';

type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const digest = (value: unknown): string => {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError('resource_wait_invalid_fact');
  return createHash('sha256').update(body).digest('hex');
};
const resourceReasons = new Set(['write_slot', 'read_slot', 'isolated_slot', 'resource_protection']);

interface ResourceWaitDependencies {
  readonly readPlan: (sessionId: string) => unknown;
  readonly inspectPlan: (plan: unknown) => unknown;
  readonly executionOf: (plan: unknown) => unknown;
  readonly readClaims: () => readonly unknown[];
  readonly ownsWorkspace: (workspaceId: string) => boolean;
}

/** Reads the existing scheduler and resource ledger. It cannot reserve, release, dispatch or mint permission. */
export function createResourceWaitPort(deps: ResourceWaitDependencies): ResourceWaitPort {
  for (const name of ['readPlan', 'inspectPlan', 'executionOf', 'readClaims', 'ownsWorkspace'] as const) {
    if (typeof deps[name] !== 'function') throw new TypeError(`ResourceWaitPort requires ${name}`);
  }
  function target(scope: ResourceWaitScope, sessionId: string): { plan: unknown; id: string } | null {
    if (!scope.workId || !scope.sessionIds.includes(sessionId) || !deps.ownsWorkspace(scope.workspaceId)) return null;
    const plan = deps.readPlan(sessionId), row = record(plan), origin = record(row.delegationOrigin);
    if (origin.sessionId !== sessionId || origin.workspaceId !== scope.workspaceId || origin.parentConversationId !== scope.parentConversationId
      || origin.workId !== undefined && origin.workId !== scope.workId) return null;
    const execution = record(deps.executionOf(plan));
    if (!text(row.planId) || !text(execution.executionEpoch) || execution.sessionId !== sessionId) return null;
    const binding = scope.executionBindings?.[sessionId];
    if (binding && (binding.executionEpoch !== execution.executionEpoch || binding.goalRevision !== execution.goalRevision)) return null;
    return { plan, id: `resource:${digest({ sessionId, execution }).slice(0, 40)}` };
  }
  function observe(scope: ResourceWaitScope, sessionId: string): { id: string; fact: ResourceWaitFact | null } | null {
    const bound = target(scope, sessionId);
    if (!bound) return null;
    const decision = record(deps.inspectPlan(bound.plan));
    if (decision.allowed === true) return { id: bound.id, fact: null };
    const reason = text(decision.reason), blocker = record(decision.blocker);
    if (blocker.kind === 'recovery' || reason === 'resource_recovery') throw new Error(text(blocker.code) || 'resource_wait_unavailable');
    if (!resourceReasons.has(reason)) return null;
    const behind = Array.isArray(decision.queuedBehind) ? decision.queuedBehind.map(row => text(record(row).sessionId)).sort() : [];
    const claims = deps.readClaims().map(record).filter(row => blocker.claimId ? row.claimId === blocker.claimId
      : behind.includes(text(record(row.execution).sessionId))).map(row => ({ claimId: row.claimId, revision: row.revision, state: row.state }))
      .sort((a, b) => text(a.claimId).localeCompare(text(b.claimId)));
    const revision = digest({ id: bound.id, reason, blocker, behind, claims });
    return { id: bound.id, fact: { sessionId, wait: { kind: 'resource', id: bound.id, revision }, reason } };
  }
  return {
    read(scope) {
      if (!deps.ownsWorkspace(scope.workspaceId)) throw new Error('lease_unavailable');
      const facts: ResourceWaitFact[] = [];
      for (const id of scope.sessionIds.slice(0, 64)) {
        const current = observe(scope, id);
        if (current?.fact) facts.push(current.fact);
      }
      return facts;
    },
    inspect(scope, wait): ResourceWaitInspection {
      if (!wait || wait.kind !== 'resource' || !wait.id || !wait.revision) return { state: 'stale', reason: 'resource_wait_invalid' };
      if (!deps.ownsWorkspace(scope.workspaceId)) return { state: 'unavailable', reason: 'lease_unavailable' };
      try {
        for (const id of scope.sessionIds.slice(0, 64)) {
          const bound = target(scope, id);
          if (bound?.id !== wait.id) continue;
          const current = observe(scope, id);
          if (!current) return { state: 'stale', reason: 'resource_wait_target_changed' };
          return current.fact ? { state: 'waiting', current: current.fact } : { state: 'ready', sessionId: id };
        }
        return { state: 'stale', reason: 'resource_wait_out_of_scope' };
      } catch (error) {
        return { state: 'unavailable', reason: error instanceof Error ? error.message : 'resource_wait_unavailable' };
      }
    },
  };
}

/** Explicit adapter for in-memory/unconstrained hosts; it never accepts a physical-resource wait. */
export function createEmptyResourceWaitPort(): ResourceWaitPort {
  return { read: () => [], inspect: () => ({ state: 'stale', reason: 'resource_wait_out_of_scope' }) };
}

export function requireResourceWaitPort(value: ResourceWaitPort | null | undefined): ResourceWaitPort {
  if (!value || typeof value.read !== 'function' || typeof value.inspect !== 'function') throw new TypeError('ResourceWaitPort is required');
  return value;
}

/** A failed read is an explicit factual blocker, never an empty/ready resource set. */
export function readResourceWaitFacts(port: ResourceWaitPort, scope: ResourceWaitScope, registered: readonly ResourceWaitReference[] = []): {
  resourceWaits: readonly ResourceWaitFact[]; resourceWaitError?: string;
} {
  try {
    const resourceWaits = port.read(scope);
    const blocked = registered.map(wait => port.inspect(scope, wait)).find(row => row.state === 'stale' || row.state === 'unavailable');
    return { resourceWaits, ...(blocked && 'reason' in blocked ? { resourceWaitError: blocked.reason } : {}) };
  }
  catch (error) { return { resourceWaits: [], resourceWaitError: error instanceof Error ? error.message : 'resource_wait_unavailable' }; }
}

export function resourceWaitScope(work: { workId: string; workspaceId: string; parentConversationId: string; sessionIds?: readonly string[] },
  state: { mandates?: Readonly<Record<string, { sessionIds: readonly string[]; revokedSessionIds?: readonly string[];
    executionBindings?: ResourceWaitScope['executionBindings'] }>> }): ResourceWaitScope {
  const mandate = state.mandates?.[work.workId];
  return { workspaceId: work.workspaceId, parentConversationId: work.parentConversationId, workId: work.workId,
    sessionIds: (mandate?.sessionIds || work.sessionIds || []).filter(id => !mandate?.revokedSessionIds?.includes(id)),
    ...(mandate?.executionBindings ? { executionBindings: mandate.executionBindings } : {}) };
}
