import { createHash } from 'node:crypto';

export const OBLIGATION_BUCKETS = ['obligationDispositions', 'obligationGrants', 'obligationHeads', 'obligationResults'];
export const OBLIGATION_FORMAT_VERSION = 11;
const ACTIONS = new Set(['retire_follow_up', 'acknowledge_unknown', 'restore_follow_up']);
const PHASES = new Set(['indexed', 'suspended', 'current']);

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function grantsOf(state) { return { ...state.obligationGrants }; }
function dispositionsOf(state) { return { ...state.obligationDispositions }; }
function headsOf(state) { return { ...state.obligationHeads }; }
function resultsOf(state) { return { ...state.obligationResults }; }

/** Coordination reducer for obligation grants and follow-up dispositions. It never writes a stop receipt or a claim. */
export function reduceExecutionObligation(state, entry) {
  if (entry.minimumExecutorVersion !== OBLIGATION_FORMAT_VERSION) throw new Error('obligation_executor_unsupported');
  if (entry.kind === 'obligation_grant') return reduceGrant(state, entry);
  if (entry.kind === 'execution_obligation') return reduceDisposition(state, entry);
  throw new Error('obligation_event_invalid');
}

function reduceGrant(state, entry) {
  const grant = clone(entry.grant);
  const grants = grantsOf(state);
  const previous = grants[grant?.grantId];
  if (!grant || typeof grant.grantId !== 'string' || !grant.grantId
    || !['pending', 'confirmed', 'revoked', 'expired'].includes(grant.status)
    || !Array.isArray(grant.items) || !grant.items.length || grant.items.length > 20
    || grant.items.some(item => typeof item.sessionId !== 'string' || typeof item.operationId !== 'string'
      || !Array.isArray(item.actions) || item.actions.some(action => !ACTIONS.has(action))
      || typeof item.evidenceRevision !== 'string')
    || grant.revision !== (previous?.revision || 0) + 1) throw new Error('obligation_grant_invalid');
  if (!previous && grant.status !== 'pending') throw new Error('obligation_grant_invalid');
  if (previous) {
    if ((previous.canonicalKey && previous.canonicalKey !== grant.canonicalKey) || previous.principal?.workspaceId !== grant.principal?.workspaceId
      || previous.principal?.parentConversationId !== grant.principal?.parentConversationId) throw new Error('obligation_grant_invalid');
    if (['revoked', 'expired'].includes(previous.status) && grant.status === 'confirmed') throw new Error('obligation_grant_replay_forbidden');
    if (previous.status === 'confirmed' && grant.status === 'pending') throw new Error('obligation_grant_replay_forbidden');
  }
  grants[grant.grantId] = grant;
  return { ...state, obligationGrants: grants };
}

function reduceDisposition(state, entry) {
  const row = clone(entry.disposition);
  const dispositions = dispositionsOf(state);
  const heads = headsOf(state);
  const previous = dispositions[row?.obligationId];
  if (!row || typeof row.obligationId !== 'string' || typeof row.sessionId !== 'string' || typeof row.operationId !== 'string'
    || !PHASES.has(row.phase) || row.revision !== (previous?.revision || 0) + 1) throw new Error('obligation_disposition_invalid');
  if (row.phase === 'suspended' && previous?.phase !== 'indexed') throw new Error('obligation_disposition_invalid');
  if (row.phase === 'current' && previous?.phase !== 'indexed') throw new Error('obligation_disposition_invalid');
  dispositions[row.obligationId] = row;
  heads[row.sessionId] = row.obligationId;
  const results = resultsOf(state);
  if (entry.audit?.auditId) results[entry.audit.auditId] = clone(entry.audit);
  return { ...state, obligationDispositions: dispositions, obligationHeads: heads, obligationResults: results };
}

export function obligationIdFor(parts) {
  return `obl_${createHash('sha256').update(JSON.stringify([parts.workspaceId, parts.sessionId, parts.planId, parts.operationId])).digest('hex')}`;
}

export function canonicalGrantKey(grantId, items, evidenceRevision) {
  const body = { evidenceRevision, grantId, items: [...items].map(item => ({
    actions: [...item.actions].sort(), operationId: item.operationId, sessionId: item.sessionId,
  })).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.operationId.localeCompare(b.operationId)) };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
