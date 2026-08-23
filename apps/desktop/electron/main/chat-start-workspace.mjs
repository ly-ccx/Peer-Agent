/**
 * New tasks may only bind a workspace that the user has already registered.
 * Preview defaults such as ~/PeerAgent are not a substitute for selection.
 */
export function resolveNewTaskWorkspacePath({
  requested,
  activeWorkspace,
  workspaces = [],
} = {}) {
  const configured = new Set(
    workspaces
      .map((workspace) => (typeof workspace?.path === 'string' ? workspace.path : ''))
      .filter(Boolean),
  );
  for (const candidate of [requested, activeWorkspace]) {
    if (typeof candidate === 'string' && candidate && configured.has(candidate)) {
      return candidate;
    }
  }
  return null;
}
