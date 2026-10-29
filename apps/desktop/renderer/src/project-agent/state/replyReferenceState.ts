import type { BotChatMessage, ConversationDisplayRow } from './botConversationState';
import type { BotReplyRow } from './botReplyContinuity';

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
export function replyReferencesForRows<Row extends ConversationDisplayRow | BotReplyRow>(rows: readonly Row[]): ReadonlyMap<Row, readonly string[]> {
  const references = new Map<Row, readonly string[]>();
  let preceding: ConversationDisplayRow | BotReplyRow | undefined;
  for (const row of rows) {
    if (row.type === 'separator') continue;
    const ids = row.type === 'reply' ? row.replyTo : row.type === 'activity' ? row.activity.replyTo : row.message.replyTo;
    const message = row.type === 'reply' ? row.message : row.type === 'message' ? row.message : undefined;
    const explicit = message && (message.proactive || message.quoteRefs.length > 0);
    const continuation = !explicit && ids.length === 1 && preceding?.type === 'message'
      && preceding.message.kind === 'user_input' && preceding.message.id === ids[0];
    references.set(row, continuation ? [] : ids);
    // Public slice paragraphs still belong to the same user input.
    if (row.type === 'message' && row.message.kind === 'agent_turn') continue;
    preceding = row;
  }
  return references;
}
