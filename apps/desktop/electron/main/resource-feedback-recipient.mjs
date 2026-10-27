/** Resolve only existing index ancestry. No history, task wakeup or permission port. */
export function resolveResourceFeedbackRecipient(conversationId, { items, conversations }) {
  if (typeof conversationId !== 'string' || !Array.isArray(items) || !Array.isArray(conversations)) return null;
  const metadata = new Map(conversations.map(row => [row.id, row]));
  const seen = new Set();
  let current = conversationId;
  for (let depth = 0; depth < 32; depth++) {
    if (!current || seen.has(current)) return null;
    seen.add(current);
    const meta = metadata.get(current);
    if (!meta || meta.archivedAt || meta.status === 'archived') return null;
    const owners = items.filter(item => item.profile?.status === 'active' && item.profile.agentConversationId === current);
    if (owners.length === 1 && owners[0].workspaceId) return { workspaceId: owners[0].workspaceId, conversationId: current };
    if (owners.length > 1) return null;
    current = meta.parentConversationId;
  }
  return null;
}
