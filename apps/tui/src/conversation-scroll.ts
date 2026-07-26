/** Conversation viewport helpers for the TUI transcript. */

export interface ConversationScrollMetrics {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}

export interface ContextUserCandidate {
  readonly id: string;
  readonly content: string;
  readonly images?: readonly unknown[];
}

/** Index of the latest user message, or -1 when none. */
export function latestUserMessageIndex(
  messages: readonly { readonly role: string }[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

export function latestUserMessage<T extends { readonly role: string }>(
  messages: readonly T[],
): T | null {
  const index = latestUserMessageIndex(messages);
  return index >= 0 ? messages[index]! : null;
}

/** Stable OpenTUI renderable id for a chat message row. */
export function conversationMessageRenderId(messageId: string): string {
  return `chat-msg-${messageId}`;
}

/**
 * Collapse a user message body into a single-line context-bar summary.
 * Keeps the bar compact so it never steals the transcript viewport.
 */
export function summarizeUserContext(
  text: string,
  imageLabel: string | null,
  maxChars = 96,
): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  if (compact) parts.push(compact);
  if (imageLabel) parts.push(imageLabel);
  const joined = parts.join(' · ') || '(empty message)';
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Pick which user message the fixed context bar should show.
 *
 * - Active turn: always the latest user message (current prompt).
 * - Idle browsing: prefer the last user message whose row is at/above the
 *   viewport top band; fall back to the latest user message.
 */
export function resolveContextUserMessageId(
  userMessageIdsInOrder: readonly string[],
  options: {
    readonly isActiveTurn: boolean;
    readonly latestUserId: string | null;
    /** Absolute screen Y for each user row, if known. */
    readonly rowScreenTops?: Readonly<Record<string, number>>;
    readonly viewportScreenTop?: number;
    readonly viewportHeight?: number;
  },
): string | null {
  if (userMessageIdsInOrder.length === 0) return null;
  const latest = options.latestUserId ?? userMessageIdsInOrder[userMessageIdsInOrder.length - 1]!;
  if (options.isActiveTurn) return latest;

  const tops = options.rowScreenTops;
  const viewportTop = options.viewportScreenTop;
  const viewportHeight = options.viewportHeight ?? 0;
  if (!tops || viewportTop == null || viewportHeight <= 0) return latest;

  // Prefer the last user row that has reached the upper band of the viewport.
  const bandBottom = viewportTop + Math.max(1, Math.floor(viewportHeight * 0.35));
  let chosen: string | null = null;
  for (const id of userMessageIdsInOrder) {
    const top = tops[id];
    if (top == null) continue;
    if (top <= bandBottom) chosen = id;
  }
  return chosen ?? latest;
}
