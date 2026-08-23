export function registeredWorkspacePath(
  candidate: string | null | undefined,
  workspaces: readonly { path: string }[],
): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return workspaces.some((workspace) => workspace.path === candidate) ? candidate : null;
}

export function workspaceRequiredNotice(isZh: boolean): string {
  return isZh ? '请先选择工作区。' : 'Select a workspace before starting a task.';
}

export function isWorkspaceRequiredNotice(message: string | null | undefined): boolean {
  return message === workspaceRequiredNotice(true) || message === workspaceRequiredNotice(false);
}
