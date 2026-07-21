/**
 * Session-scoped "completed but unread" markers for the conversation sidebar.
 *
 * Semantics (expression-layer only):
 * - Set when a conversation leaves the running set and is not the active conversation.
 * - Clear when the user opens/selects that conversation (or when it is already active).
 * - Not persisted across app restarts.
 */

export function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Derive the next completed-unread set after the running-id set changes.
 * Completions that finish while the conversation is active are not marked unread.
 */
export function nextCompletedUnreadIds(input: {
  readonly previousRunningIds: ReadonlySet<string>;
  readonly nextRunningIds: ReadonlySet<string>;
  readonly activeConversationId: string | null;
  readonly completedUnreadIds: ReadonlySet<string>;
}): Set<string> {
  const next = new Set(input.completedUnreadIds);
  for (const id of input.previousRunningIds) {
    if (input.nextRunningIds.has(id)) continue;
    if (id === input.activeConversationId) {
      next.delete(id);
      continue;
    }
    next.add(id);
  }
  // Keep active conversation clean even if it was previously marked.
  if (input.activeConversationId) {
    next.delete(input.activeConversationId);
  }
  return next;
}

/** Clear the completed-unread mark for a conversation the user just opened. */
export function clearCompletedUnreadId(
  completedUnreadIds: ReadonlySet<string>,
  conversationId: string | null | undefined,
): Set<string> {
  if (!conversationId || !completedUnreadIds.has(conversationId)) {
    return new Set(completedUnreadIds);
  }
  const next = new Set(completedUnreadIds);
  next.delete(conversationId);
  return next;
}

/** Whether the sidebar should show the completed-unread green dot. */
export function shouldShowCompletedUnreadDot(input: {
  readonly conversationId: string;
  readonly isRunning: boolean;
  readonly isCompactionVisible: boolean;
  readonly completedUnreadIds?: ReadonlySet<string> | null;
}): boolean {
  if (input.isRunning || input.isCompactionVisible) return false;
  return Boolean(input.completedUnreadIds?.has(input.conversationId));
}
