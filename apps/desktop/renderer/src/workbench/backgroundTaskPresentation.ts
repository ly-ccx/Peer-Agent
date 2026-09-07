import type { ManagedShellTask } from '@peer-agent/protocol';

export function backgroundTaskList(tasks: readonly ManagedShellTask[], filters: {
  workspace?: string; sourceConversation?: string;
} = {}): ManagedShellTask[] {
  return tasks.filter((task) => task.runInBackground === true
    && (!filters.workspace || task.cwd === filters.workspace)
    && (!filters.sourceConversation || task.conversationId === filters.sourceConversation))
    .sort((a, b) => {
      const rank = (task: ManagedShellTask) => ['running', 'stopping'].includes(task.status) ? 0 : 1;
      return rank(a) - rank(b) || (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0);
    });
}

export function backgroundTaskStatus(task: ManagedShellTask, isZh: boolean): string {
  const status = task.timedOut ? 'timeout' : task.status;
  const labels: Record<string, readonly [string, string]> = {
    running: ['运行中', 'Running'], stopping: ['停止中', 'Stopping'],
    success: ['已完成', 'Completed'], completed: ['已完成', 'Completed'],
    cancelled: ['已停止', 'Stopped'], failed: ['失败', 'Failed'],
    timeout: ['超时', 'Timed out'], timed_out: ['超时', 'Timed out'],
  };
  return labels[status]?.[isZh ? 0 : 1] ?? status;
}

// A TCP listener proves a bound port, not an HTTP/HTTPS scheme or readiness.
export function backgroundTaskAddresses(task: ManagedShellTask): string[] {
  if (task.status !== 'running') return [];
  return (task.listeners ?? []).filter((entry) => entry.transport === 'tcp'
    && Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535
    && entry.pid > 0 && Number.isFinite(Date.parse(entry.observedAt)))
    .map((entry) => `${entry.host}:${entry.port}`);
}
