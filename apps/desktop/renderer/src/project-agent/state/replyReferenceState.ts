import type { BotChatMessage, ConversationDisplayRow } from './botConversationState';

export interface ReplyAnchor {
  readonly author: string | null;
  readonly excerpt: string;
}

/** Loaded source facts only. Visual clamping never truncates the stored quote. */
export function replyAnchorsForMessages(messages: readonly BotChatMessage[], labels: { readonly user: string; readonly bot: string }): ReadonlyMap<string, ReplyAnchor> {
  return new Map(messages.map(message => [message.id, {
    author: message.kind === 'user_input' && message.role === 'user' ? labels.user
      : message.kind === 'agent_reply' && message.role === 'assistant' ? labels.bot : null,
    excerpt: message.content.replace(/\s+/g, ' ').trim(),
  }]));
}

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
