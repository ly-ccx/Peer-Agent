import { continuationDecision } from './continuation-policy.mjs';
import { decideFollowUp } from '@peer-agent/protocol';

/** Current child facts determine who still owes work after a public update. */
export function repairOwnership(sessions) {
  const rows = sessions.map(row => ({ row, followUp: row.followUp ?? decideFollowUp({ status: row.status }, {
    interrupted: row.interrupted, interruptionOrigin: row.interruptionOrigin,
  }, row.executionOwnership) }));
  return {
    repairSessionIds: rows.filter(({ followUp }) => followUp.owner === 'bot' && followUp.reason !== 'live_execution').map(({ row }) => row.sessionId),
    waiting: rows.filter(({ followUp }) => followUp.owner === 'bot' && followUp.reason === 'live_execution').map(({ row }) => row),
    needsUser: rows.some(({ followUp }) => followUp.owner === 'user'),
  };
}

export function stateAfterReply(sessions) {
  const owner = repairOwnership(sessions);
  return owner.repairSessionIds.length ? 'runnable' : owner.needsUser ? 'waiting_user'
    : owner.waiting.length ? 'waiting_children' : 'delivered';
}

export function ownedSessions(work, job, roster, reportedSessionIds = []) {
  return (Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []).filter(row =>
    work.sessionIds.includes(row.sessionId) || reportedSessionIds.includes(row.sessionId)
    || (job.events || []).some(event => event.sessionId === row.sessionId)
    || row.origin?.anchorMessageId && work.anchorInputIds.some(id => `input-${id}` === row.origin.anchorMessageId));
}

export function repairProgressDecision(previous, outcome, roster, sources) {
  // Rephrasing the same public update is not progress on a technical blocker.
  const materialRounds = repairOwnership(sources).repairSessionIds.length ? (outcome.rounds || []).map(round => ({ ...round,
    toolCalls: (round.toolCalls || []).filter(call => !['post_reply', 'local.delegation.post_reply'].includes(call.name)) })) : outcome.rounds;
  return continuationDecision({ previous, rounds: materialRounds, roster: sources, yielded: outcome.yielded });
}
