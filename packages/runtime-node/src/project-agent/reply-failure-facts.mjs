/** A subsequent attempt is not a successful delivery. No timestamp or prose heuristic. */
export function replyFailureStatus(message, messages, works, deliveries, sessions, now = new Date().toISOString()) {
  const turn = messages.find(row => row.id === message.turnId && row.kind === 'agent_turn');
  const work = works.find(row => row.workId === (message.meta?.workId || turn?.meta?.workId))
    || works.find(row => row.recovery?.failedTurnId === message.turnId || row.attemptId === message.turnId);
  const index = messages.indexOf(message);
  const later = messages.slice(index + 1);
  const recovered = work && later.find(row => row.kind === 'agent_reply' && row.turnId !== message.turnId
    && row.meta?.workId === work.workId && deliveries[row.id]?.state === 'delivered');
  const newer = work && later.some(row => row.kind === 'agent_turn' && row.meta?.workId === work.workId);
  const active = sessions.filter(row => work?.sessionIds?.includes(row.sessionId)
    && ['queued', 'starting', 'running', 'verifying'].includes(row.status)).map(row => row.sessionId);
  const reserved = work?.state === 'retry_wait' && work.recovery?.reservationId
    && work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === work.recovery.reservationId)
    && Date.parse(work.recovery.deadlineAt) > Date.parse(now);
  const phase = work?.state === 'cancelled' ? 'cancelled' : work?.state === 'paused' ? 'paused'
    : recovered ? 'recovered' : newer ? 'superseded'
    : work?.state === 'runnable' || reserved ? 'retrying' : 'current';
  return { phase, turnKind: turn?.turnKind === 'wake' ? 'wake' : 'user', activeSessionIds: active,
    ...(work ? { workId: work.workId } : {}), ...(recovered ? { recoveredByReplyId: recovered.id } : {}) };
}
