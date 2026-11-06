/** View identities only; closing a tab never changes the underlying conversation or run. */
export interface ResourceConversation {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly conversationId: string;
  readonly title: string;
  readonly task?: { readonly sessionId: string; readonly planId: string };
  readonly onOpenBot?: () => void;
}

export interface ResourceConversations {
  readonly owner: string | null;
  readonly tabs: readonly ResourceConversation[];
  readonly activeId: string | null;
}

export function openResourceConversation(state: ResourceConversations, target: ResourceConversation): ResourceConversations {
  if (target.workspaceId !== state.owner || !target.conversationId) return state;
  const existing = state.tabs.some(tab => tab.conversationId === target.conversationId);
  return { ...state, activeId: target.conversationId, tabs: existing
    ? state.tabs.map(tab => tab.conversationId === target.conversationId ? target : tab)
    : [...state.tabs, target] };
}

export function closeResourceConversation(state: ResourceConversations, id: string): ResourceConversations {
  const index = state.tabs.findIndex(tab => tab.conversationId === id);
  if (index < 0) return state;
  return { ...state, tabs: state.tabs.filter(tab => tab.conversationId !== id),
    activeId: state.activeId === id ? state.tabs[index + 1]?.conversationId ?? state.tabs[index - 1]?.conversationId ?? null : state.activeId };
}
