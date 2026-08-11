import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

export interface ShellThreadTask {
  readonly taskId: string;
  readonly toolCallId?: string;
  readonly command: string;
  readonly cwd?: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
  readonly exitCode?: number | null;
  readonly stopReason?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface BackgroundThreadsViewProps {
  readonly isZh: boolean;
  /** 工作台卡片点击后要聚焦的 shell taskId（不含 shell: 前缀）。 */
  readonly focusTaskId?: string | null;
}

function asTask(raw: unknown): ShellThreadTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
  if (!taskId) return null;
  return {
    taskId,
    toolCallId: typeof row.toolCallId === 'string' ? row.toolCallId : undefined,
    command: typeof row.command === 'string' ? row.command : '',
    cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
    status: typeof row.status === 'string' ? row.status : 'unknown',
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : undefined,
    completedAt:
      typeof row.completedAt === 'string'
        ? row.completedAt
        : row.completedAt === null
          ? null
          : undefined,
    exitCode: typeof row.exitCode === 'number' ? row.exitCode : row.exitCode === null ? null : undefined,
    stopReason: typeof row.stopReason === 'string' ? row.stopReason : null,
    stdout: typeof row.stdout === 'string' ? row.stdout : undefined,
    stderr: typeof row.stderr === 'string' ? row.stderr : undefined,
  };
}

function statusLabel(isZh: boolean, status: string): string {
  const s = status.toLowerCase();
  if (s === 'running') return isZh ? '运行中' : 'Running';
  if (s === 'completed') return isZh ? '已完成' : 'Completed';
  if (s === 'failed') return isZh ? '失败' : 'Failed';
  if (s === 'cancelled') return isZh ? '已停止' : 'Stopped';
  if (s === 'timed_out') return isZh ? '超时' : 'Timed out';
  return status || (isZh ? '未知' : 'Unknown');
}

function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    return new Date(t).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function truncate(text: string, max = 120): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function BackgroundThreadsView({ isZh, focusTaskId }: BackgroundThreadsViewProps) {
  const [tasks, setTasks] = useState<readonly ShellThreadTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const listed = await clientApi.listShellTasks();
      const next = (Array.isArray(listed) ? listed : [])
        .map(asTask)
        .filter((item): item is ShellThreadTask => item != null);
      // 运行中优先，其余按开始时间倒序。
      next.sort((a, b) => {
        const ar = a.status === 'running' ? 0 : 1;
        const br = b.status === 'running' ? 0 : 1;
        if (ar !== br) return ar - br;
        return Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '');
      });
      setTasks(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      void reload();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (focusTaskId) {
      setSelectedId(focusTaskId);
      return;
    }
    if (!selectedId && tasks.length > 0) {
      setSelectedId(tasks[0].taskId);
    }
  }, [focusTaskId, selectedId, tasks]);

  const selected = useMemo(
    () => tasks.find((task) => task.taskId === selectedId) ?? null,
    [tasks, selectedId],
  );

  const stopTask = useCallback(async (taskId: string) => {
    setBusyId(taskId);
    try {
      await clientApi.stopShellTask(taskId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  if (tasks.length === 0) {
    return (
      <div className="workbench-empty bg-threads-empty">
        <div className="workbench-empty-title">
          {isZh ? '暂无后台线程' : 'No background threads'}
        </div>
        <p className="workbench-empty-hint">
          {isZh
            ? 'Peer 通过 shell 开启后台任务后，会显示在这里，可查看命令与停止。'
            : 'Background shell tasks started by Peer will show up here for inspect/stop.'}
        </p>
        {error ? <p className="workbench-empty-meta">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="bg-threads-view">
      <div className="bg-threads-list" role="list">
        {tasks.map((task) => {
          const active = task.taskId === selected?.taskId;
          const running = task.status === 'running';
          return (
            <button
              key={task.taskId}
              type="button"
              role="listitem"
              className={`bg-threads-item${active ? ' is-active' : ''}${running ? ' is-running' : ''}`}
              onClick={() => setSelectedId(task.taskId)}
            >
              <span className="bg-threads-item-status">{statusLabel(isZh, task.status)}</span>
              <span className="bg-threads-item-command" title={task.command}>
                {truncate(task.command || task.taskId, 80)}
              </span>
              <span className="bg-threads-item-meta">{formatTime(task.startedAt)}</span>
            </button>
          );
        })}
      </div>

      <div className="bg-threads-detail">
        {selected ? (
          <>
            <div className="bg-threads-detail-header">
              <div>
                <div className="bg-threads-detail-status">
                  {statusLabel(isZh, selected.status)}
                </div>
                <div className="bg-threads-detail-id" title={selected.taskId}>
                  {selected.taskId}
                </div>
              </div>
              {selected.status === 'running' ? (
                <button
                  type="button"
                  className="bg-threads-stop"
                  disabled={busyId === selected.taskId}
                  onClick={() => void stopTask(selected.taskId)}
                >
                  {busyId === selected.taskId
                    ? (isZh ? '停止中…' : 'Stopping…')
                    : (isZh ? '停止' : 'Stop')}
                </button>
              ) : null}
            </div>

            <label className="bg-threads-field">
              <span>{isZh ? '命令' : 'Command'}</span>
              <pre>{selected.command || '—'}</pre>
            </label>
            <label className="bg-threads-field">
              <span>cwd</span>
              <pre>{selected.cwd || '—'}</pre>
            </label>
            <div className="bg-threads-meta-row">
              <span>{isZh ? '开始' : 'Started'}: {formatTime(selected.startedAt)}</span>
              <span>{isZh ? '结束' : 'Ended'}: {formatTime(selected.completedAt)}</span>
              {typeof selected.exitCode === 'number' ? (
                <span>exit: {selected.exitCode}</span>
              ) : null}
            </div>
            {selected.stdout ? (
              <label className="bg-threads-field">
                <span>stdout</span>
                <pre className="bg-threads-output">{selected.stdout}</pre>
              </label>
            ) : null}
            {selected.stderr ? (
              <label className="bg-threads-field">
                <span>stderr</span>
                <pre className="bg-threads-output">{selected.stderr}</pre>
              </label>
            ) : null}
            {error ? <p className="bg-threads-error">{error}</p> : null}
          </>
        ) : (
          <div className="workbench-empty">
            <div className="workbench-empty-title">
              {isZh ? '选择一个后台线程' : 'Select a background thread'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
