/** Retry receipts are backed by a completed canonical turn, never by an ended wait. */
export async function retryProjectAgentTurn({ workspaceId, turnId }, {
  holdsLease, resolveConversationId, conversationStore, projectFacts, host,
}) {
  if (holdsLease(workspaceId) !== true) return { ok: false, code: 'HOST_OFFLINE' };
  const conversationId = resolveConversationId(workspaceId);
  const readMessages = () => conversationStore.getPersistedConversationHistory(conversationId)?.messages || [];
  const messages = readMessages();
  const card = messages.find(message => message.turnId === turnId && ['agent_unavailable', 'agent_stopped'].includes(message.card));
  if (!card) return { ok: false, code: 'NOT_FOUND' };
  if (projectFacts.cards(workspaceId).find(item => item.cardId === `card:${card.card}:${turnId}`)?.resolvedState === 'resolved') {
    return { ok: true, replayed: true };
  }
  if (messages.slice(messages.indexOf(card) + 1).some(message => message.kind === 'agent_turn')) {
    return { ok: false, code: 'STALE_TURN' };
  }
  const runner = host.runnerFor(workspaceId);
  let result;
  if (card.card === 'agent_stopped' && runner?.activity()?.turnId === turnId) {
    result = await runner.retryStopped(turnId);
    if (result?.skipped) return { ok: false, code: 'STALE_TURN' };
  } else if (runner) result = await runner.retry(turnId);
  else {
    await host.sync([workspaceId]);
    const restored = host.runnerFor(workspaceId);
    if (!restored) return { ok: false, code: 'RECOVERY_FAILED' };
    result = await restored.retry(turnId);
  }
  if (result?.ok === false) return result;
  if (holdsLease(workspaceId) !== true || !host.runnerFor(workspaceId)) return { ok: false, code: 'HOST_OFFLINE' };
  if (host.runnerFor(workspaceId).status() === 'error') return { ok: false, code: 'TURN_FAILED' };
  const persisted = readMessages();
  const cardIndex = persisted.findIndex(message => message.id === card.id);
  const original = messages.find(message => message.id === turnId && message.kind === 'agent_turn');
  const workId = card.meta?.workId || original?.meta?.workId || result?.workId;
  if (workId && result?.workId && result.workId !== workId) return { ok: false, code: 'STALE_TURN' };
  const completed = cardIndex >= 0 && persisted.slice(cardIndex + 1).findLast(message => message.kind === 'agent_turn'
    && (!workId || message.meta?.workId === workId) && (!result?.turnId || message.id === result.turnId));
  if (!completed || completed.meta?.diagnosticTiming?.outcome !== 'done') return { ok: false, code: 'TURN_FAILED' };
  projectFacts.resolve(workspaceId, card.cards?.[0]?.cardId || `card:${card.card}:${turnId}`);
  return { ok: true };
}
