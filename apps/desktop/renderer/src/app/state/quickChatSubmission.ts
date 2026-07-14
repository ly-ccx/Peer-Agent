export function shouldRefreshQuickChatConversationList(
  createdWorkspacePath: string,
  activeWorkspacePath: string | null,
): boolean {
  return createdWorkspacePath === activeWorkspacePath;
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
