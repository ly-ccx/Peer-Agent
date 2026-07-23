export function shouldRefreshQuickChatConversationList(
  createdWorkspacePath: string,
  activeWorkspacePath: string | null,
): boolean {
  return createdWorkspacePath === activeWorkspacePath;
}

export async function navigateToQuickChatConversation(
  input: {
    conversationId: string;
    workspacePath: string;
  },
  navigation: {
    openChatPage: () => void;
    activateWorkspace: (workspacePath: string) => Promise<void>;
    refreshConversations: (workspacePath: string) => Promise<void>;
    selectConversation: (conversationId: string) => void;
  },
): Promise<void> {
  navigation.openChatPage();
  if (input.workspacePath) {
    await navigation.activateWorkspace(input.workspacePath);
    await navigation.refreshConversations(input.workspacePath);
  }
  navigation.selectConversation(input.conversationId);
}

export async function runQuickChatSubmission(
  submit: () => Promise<void>,
  onError: (reason: unknown) => void,
  onSettled: () => void,
): Promise<void> {
  try {
    await submit();
  } catch (reason) {
    onError(reason);
  } finally {
    onSettled();
  }
}
