import type { ConversationDisplayRow } from './botConversationState';

/** Routing anchors remain intact; only context that adds information is shown. */
export function replyReferencesForRows(rows: readonly ConversationDisplayRow[]): ReadonlyMap<ConversationDisplayRow, readonly string[]> {
  const references = new Map<ConversationDisplayRow, readonly string[]>();
  let preceding: Exclude<ConversationDisplayRow, { type: 'separator' }> | undefined;
  for (const row of rows) {
    if (row.type === 'separator') continue;
    const ids = row.type === 'activity' ? row.activity.replyTo : row.message.replyTo;
    const explicit = row.type === 'message' && (row.message.proactive || row.message.quoteRefs.length > 0);
    const continuation = !explicit && ids.length === 1 && preceding?.type === 'message'
      && preceding.message.kind === 'user_input' && preceding.message.id === ids[0];
    references.set(row, continuation ? [] : ids);
    preceding = row;
  }
  return references;
}
