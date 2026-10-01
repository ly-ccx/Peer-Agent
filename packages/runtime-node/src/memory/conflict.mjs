/** The curator supplies a single-value topic; the host compares claims within its scope. */
export function memoryConflictDecision(item, existing = []) {
  const conflicts = existing.filter(other => other.id !== item.id && ['active', 'conflicted'].includes(other.status)
    && other.scope === item.scope && (item.scope === 'user' || other.workspaceId === item.workspaceId)
    && other.kind === item.kind && item.topicKey && other.topicKey === item.topicKey
    && item.topicValue && other.topicValue && other.topicValue !== item.topicValue);
  const replaceIds = [], conflictIds = [];
  for (const other of conflicts) {
    const authoritative = ['stated', 'verified'].includes(item.trust)
      && Date.parse(item.createdAt) > Date.parse(other.createdAt);
    (authoritative ? replaceIds : conflictIds).push(other.id);
  }
  return { replaceIds: replaceIds.sort(), conflictIds: conflictIds.sort() };
}
