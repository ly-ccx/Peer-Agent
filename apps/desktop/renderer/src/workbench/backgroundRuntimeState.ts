import type { ManagedShellTask } from '@peer-agent/protocol';

export const isActiveRun = (task: ManagedShellTask) => task.status === 'running' || task.status === 'stopping';
export const isFailedRun = (task: ManagedShellTask) => task.status === 'failed' || task.timedOut === true;

/** Presentation order only. Records and statuses always come from the latest Runtime snapshot. */
export function orderBackgroundRuns(snapshot: readonly ManagedShellTask[], previousIds: readonly string[] = []) {
  const runs = snapshot.filter((task) => task.runInBackground === true);
  const rank = (task: ManagedShellTask) => isFailedRun(task) ? 0 : isActiveRun(task) ? 1 : 2;
  const previous = new Map(previousIds.map((id, index) => [id, index]));
  return [...runs].sort((a, b) => {
    const ai = previous.get(a.taskId);
    const bi = previous.get(b.taskId);
    if (ai !== undefined || bi !== undefined) return (ai ?? Infinity) - (bi ?? Infinity);
    return rank(a) - rank(b) || (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0)
      || a.taskId.localeCompare(b.taskId);
  });
}

/** IDs keep rows in place while a panel is open, not stale copies of running records. */
export function visibleBackgroundRuns(runs: readonly ManagedShellTask[], pinnedIds: readonly string[], historyOpen = false, historyLimit = 20) {
  const pinned = new Set(pinnedIds);
  const primary = runs.filter((task) => pinned.has(task.taskId) || isActiveRun(task) || isFailedRun(task));
  const primaryIds = new Set(primary.map((task) => task.taskId));
  const history = runs.filter((task) => !primaryIds.has(task.taskId));
  return { primary, history: historyOpen ? history.slice(0, historyLimit) : [], historyCount: history.length };
}

export function backgroundRunSource(task: ManagedShellTask, sources: readonly { id: string; title: string }[] | null, isZh: boolean) {
  if (!task.conversationId) return { label: isZh ? '来源未知' : 'Unknown source', id: null };
  const source = sources?.find((entry) => entry.id === task.conversationId);
  if (source) return { label: source.title, id: source.id };
  return { label: sources === null ? (isZh ? '来源暂不可用' : 'Source unavailable')
    : (isZh ? '来源任务已删除' : 'Source task deleted'), id: null };
}

export type StopRequest = { readonly taskId: string; readonly phase: 'confirm' | 'requesting' | 'unconfirmed' | 'rejected'; readonly error?: string };

/** Acknowledgements describe requests only; the Runtime snapshot decides the displayed run status. */
export function reconcileStopRequest(request: StopRequest | null, runs: readonly ManagedShellTask[]): StopRequest | null {
  if (!request) return null;
  const task = runs.find((run) => run.taskId === request.taskId);
  if (task && !isActiveRun(task)) return null;
  if (task?.status === 'stopping') return null;
  return request;
}

export function backgroundReadPresentation(hasSnapshot: boolean, error: string | null) {
  return error ? (hasSnapshot ? 'stale' : 'error') : hasSnapshot ? 'ready' : 'loading';
}
