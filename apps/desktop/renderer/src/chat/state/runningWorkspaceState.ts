/**
 * Workspace running-dot helpers (ADR 27 expression layer).
 *
 * Truth for "which workspaces still have running streams" comes from main's
 * active-stream projection. Local ChatSurface streaming signals may update
 * conversation spinners earlier; they must also keep workspace dots in sync,
 * otherwise a finished turn can leave a stale yellow/green workspace indicator.
 */

export type ActiveStreamWorkspaceLike = {
  readonly originWorkspacePath?: string | null;
  readonly workspacePath?: string | null;
};

/** Normalize workspace path keys so trailing slashes do not create sticky "other" dots. */
export function normalizeWorkspacePathKey(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  // Keep POSIX root as "/" ; strip trailing separators on everything else.
  if (trimmed === '/' || trimmed === '\\') return '/';
  return trimmed.replace(/[\\/]+$/, '');
}

/** Derive running workspace set from authoritative active-stream projections. */
export function deriveRunningWorkspacePaths(
  streams: readonly ActiveStreamWorkspaceLike[] | null | undefined,
): Set<string> {
  const next = new Set<string>();
  if (!streams) return next;
  for (const stream of streams) {
    const origin = normalizeWorkspacePathKey(stream.originWorkspacePath ?? stream.workspacePath);
    if (origin) next.add(origin);
  }
  return next;
}

/**
 * Apply a local isStreaming edge to the workspace-dot set.
 *
 * - streaming start: mark the conversation's origin workspace as running.
 * - streaming stop with zero remaining running conversations: clear all dots
 *   (idle means no workspace should stay lit).
 * - streaming stop with other conversations still running: drop this workspace
 *   optimistically; the next main active-stream broadcast re-adds it if needed.
 */
export function applyLocalStreamingWorkspaceChange(input: {
  readonly prev: ReadonlySet<string>;
  readonly workspacePath: string | null | undefined;
  readonly isStreaming: boolean;
  readonly remainingRunningConversationCount: number;
}): Set<string> {
  if (!input.isStreaming && input.remainingRunningConversationCount <= 0) {
    return new Set();
  }

  const key = normalizeWorkspacePathKey(input.workspacePath);
  if (!key) return new Set(input.prev);

  if (input.isStreaming) {
    if (input.prev.has(key)) return new Set(input.prev);
    const next = new Set(input.prev);
    next.add(key);
    return next;
  }

  if (!input.prev.has(key)) return new Set(input.prev);
  const next = new Set(input.prev);
  next.delete(key);
  return next;
}

/** Sidebar: is there a running stream whose origin is not the active workspace? */
export function hasRunningWorkspaceOtherThan(
  runningWorkspacePaths: ReadonlySet<string> | null | undefined,
  activeWorkspace: string | null | undefined,
): boolean {
  if (!runningWorkspacePaths || runningWorkspacePaths.size === 0) return false;
  const activeKey = normalizeWorkspacePathKey(activeWorkspace);
  for (const path of runningWorkspacePaths) {
    const key = normalizeWorkspacePathKey(path);
    if (!key) continue;
    if (!activeKey || key !== activeKey) return true;
  }
  return false;
}

/** Sidebar: does this workspace path currently have a running stream? */
export function hasRunningWorkspaces(
  runningWorkspacePaths: ReadonlySet<string> | null | undefined,
): boolean {
  return (runningWorkspacePaths?.size ?? 0) > 0;
}

export function isWorkspaceRunning(
  runningWorkspacePaths: ReadonlySet<string> | null | undefined,
  workspacePath: string | null | undefined,
): boolean {
  if (!runningWorkspacePaths || runningWorkspacePaths.size === 0) return false;
  const key = normalizeWorkspacePathKey(workspacePath);
  if (!key) return false;
  if (runningWorkspacePaths.has(key)) return true;
  // Tolerate pre-normalized entries already stored with trailing slash variants.
  for (const path of runningWorkspacePaths) {
    if (normalizeWorkspacePathKey(path) === key) return true;
  }
  return false;
}
