export type SearchConversationHit = {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly updatedAt?: string;
  readonly createdAt?: string;
};

function normalizeWorkspacePath(workspacePath?: string | null): string {
  return String(workspacePath || '').replace(/[\\/]+$/, '');
}

function workspaceShortName(workspacePath?: string | null): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

export type SearchConversationWorkspaceGroup = {
  readonly workspacePath: string | null;
  readonly workspaceName: string;
  readonly isActiveWorkspace: boolean;
  readonly conversations: readonly SearchConversationHit[];
};

export function groupSearchConversationsByWorkspace(
  conversations: readonly SearchConversationHit[],
  activeWorkspace?: string | null,
): readonly SearchConversationWorkspaceGroup[] {
  const activeKey = normalizeWorkspacePath(activeWorkspace);
  const groups = new Map<string, {
    workspacePath: string | null;
    workspaceName: string;
    isActiveWorkspace: boolean;
    conversations: SearchConversationHit[];
  }>();

  for (const conversation of conversations) {
    const workspacePath = normalizeWorkspacePath(conversation.workspacePath);
    const key = workspacePath || '__unassigned__';
    const existing = groups.get(key);
    if (existing) {
      existing.conversations.push(conversation);
      continue;
    }
    groups.set(key, {
      workspacePath: workspacePath || null,
      workspaceName: workspaceShortName(workspacePath),
      isActiveWorkspace: Boolean(activeKey && workspacePath === activeKey),
      conversations: [conversation],
    });
  }

  return [...groups.values()].sort((left, right) => {
    if (left.isActiveWorkspace !== right.isActiveWorkspace) {
      return left.isActiveWorkspace ? -1 : 1;
    }
    if (left.workspacePath === null !== (right.workspacePath === null)) {
      return left.workspacePath === null ? 1 : -1;
    }
    return 0;
  });
}
