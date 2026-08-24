import { UNASSIGNED_WORKSPACE_KEY } from './workspaceTaskTree.ts';

/** 每个展开工作区首屏只露出这么多任务，其余点「更多」。 */
export const WORKSPACE_TASK_PREVIEW_SIZE = 12;

export function workspaceListPath(workspaceKey: string): string | null {
  return workspaceKey === UNASSIGNED_WORKSPACE_KEY ? null : workspaceKey;
}

export function mergeConversationLists<T extends { id: string }>(
  primary: readonly T[],
  extra: readonly T[],
): T[] {
  const seen = new Set(primary.map((item) => item.id));
  const merged = [...primary];
  for (const item of extra) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function previewWorkspaceTasks<T>(
  tasks: readonly T[],
  revealedCount: number,
): { readonly visible: readonly T[]; readonly canShowMore: boolean } {
  const limit = Math.max(0, revealedCount);
  return {
    visible: tasks.slice(0, limit),
    canShowMore: tasks.length > limit,
  };
}

export function nextRevealedTaskCount(current: number, loadedCount: number): number {
  if (loadedCount <= 0) return current;
  return Math.min(loadedCount, current + WORKSPACE_TASK_PREVIEW_SIZE);
}

export function shouldFetchWorkspaceTaskPage(params: {
  readonly revealedCount: number;
  readonly loadedCount: number;
  readonly hasMore: boolean;
  readonly fetched: boolean;
}): boolean {
  if (params.loadedCount > params.revealedCount) return false;
  return !params.fetched || params.hasMore;
}
