/** Current child facts determine who still owes work after a public update. */
export function repairOwnership(sessions) {
  return {
    repairSessionIds: sessions.filter(row => row.status === 'waiting_agent').map(row => row.sessionId),
    waiting: sessions.filter(row => ['queued', 'starting', 'running', 'verifying'].includes(row.status)),
    needsUser: sessions.some(row => row.status === 'waiting_user'),
  };
}

export function stateAfterReply(sessions) {
  const owner = repairOwnership(sessions);
  return owner.repairSessionIds.length ? 'runnable' : owner.needsUser ? 'waiting_user'
    : owner.waiting.length ? 'waiting_children' : 'delivered';
}
