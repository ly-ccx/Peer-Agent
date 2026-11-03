import { continuationDecision } from './continuation-policy.mjs';
import { runtimeSessionOwnership } from '@peer-agent/protocol';
import { decideRuntimeDisposition } from './runtime-disposition.ts';

/** Current child facts determine who still owes work after a public update. */
export function repairOwnership(sessions) {
  const ownership = runtimeSessionOwnership(sessions);
  return { ...ownership, waiting: sessions.filter(row => ownership.waitingSessionIds.includes(row.sessionId)) };
}

export function stateAfterReply(sessions) {
  return decideRuntimeDisposition({ sessions }).state;
}

export function ownedSessions(work, job, roster) {
  // Reply citations and wake events are observations. Custody needs the original binding or anchor.
  return (Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []).filter(row =>
    (!row.workspaceId || !work.workspaceId || row.workspaceId === work.workspaceId)
    && (!row.origin?.parentConversationId || !work.parentConversationId || row.origin.parentConversationId === work.parentConversationId)
    && (!row.origin?.workId || row.origin.workId === work.workId) && (
    work.sessionIds?.includes(row.sessionId) || row.origin?.workId === work.workId
    || (job.events || []).some(event => event.sessionId === row.sessionId && work.pendingEventIds?.includes(event.eventId)
      && (!event.workspaceId || !work.workspaceId || event.workspaceId === work.workspaceId))
    || row.origin?.anchorMessageId && work.anchorInputIds?.some(id => `input-${id}` === row.origin.anchorMessageId)));
}

export function repairProgressDecision(previous, outcome, roster, sources) {
  // Rephrasing the same public update is not progress on a technical blocker.
  const materialRounds = repairOwnership(sources).repairSessionIds.length ? (outcome.rounds || []).map(round => ({ ...round,
    toolCalls: (round.toolCalls || []).filter(call => !['post_reply', 'local.delegation.post_reply'].includes(call.name)) })) : outcome.rounds;
  return continuationDecision({ previous, rounds: materialRounds, roster: sources, yielded: outcome.yielded });
}
