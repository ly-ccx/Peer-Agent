export const UNASSIGNED_WORKSPACE_KEY = '__unassigned__';

export function isWorkspaceTaskTreeOpen(input: {
  readonly path: string;
  readonly toggled: ReadonlySet<string>;
  readonly activeWorkspace: string | null;
  readonly focusedWorkspace: string | null;
}): boolean {
  const defaultOpen =
    input.path === input.activeWorkspace || input.path === input.focusedWorkspace;
  return input.toggled.has(input.path) ? !defaultOpen : defaultOpen;
}

export function nextWorkspaceTreeToggles(
  current: ReadonlySet<string>,
  path: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** 激活工作区后清掉手动折叠，让当前区按默认展开。 */
export function openWorkspaceTreeToggles(
  current: ReadonlySet<string>,
  path: string,
): Set<string> {
  const next = new Set(current);
  next.delete(path);
  return next;
}
