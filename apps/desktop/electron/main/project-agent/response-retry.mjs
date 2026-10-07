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
  if (card.card === 'agent_stopped' && runner?.activity()?.turnId === turnId) {
    if ((await runner.retryStopped(turnId))?.skipped) return { ok: false, code: 'STALE_TURN' };
  } else if (runner?.parked()) await runner.retry();
  else {
    const turn = messages.find(message => message.id === turnId && message.kind === 'agent_turn');
    await host.sync([workspaceId]);
    const restored = host.runnerFor(workspaceId);
    if (!restored) return { ok: false, code: 'RECOVERY_FAILED' };
    if (restored.parked()) await restored.retry();
    else if (turn?.userInputs?.length) await restored.enqueueUserInputs(turn.userInputs);
    else await restored.retry();
  }
  if (holdsLease(workspaceId) !== true || !host.runnerFor(workspaceId)) return { ok: false, code: 'HOST_OFFLINE' };
  if (host.runnerFor(workspaceId).status() === 'error') return { ok: false, code: 'TURN_FAILED' };
  const persisted = readMessages();
  const cardIndex = persisted.findIndex(message => message.id === card.id);
  const completed = cardIndex >= 0 && persisted.slice(cardIndex + 1).findLast(message => message.kind === 'agent_turn');
  if (!completed || completed.meta?.diagnosticTiming?.outcome !== 'done') return { ok: false, code: 'TURN_FAILED' };
  projectFacts.resolve(workspaceId, card.cards?.[0]?.cardId || `card:${card.card}:${turnId}`);
  return { ok: true };
}
