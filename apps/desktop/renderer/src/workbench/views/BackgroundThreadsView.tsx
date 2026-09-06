import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

import type { ManagedShellTask } from '@peer-agent/protocol';
import { backgroundTaskList, backgroundTaskStatus, backgroundTaskAddresses } from '../backgroundTaskPresentation';
export type ShellThreadTask = ManagedShellTask;

interface BackgroundThreadsViewProps {
  readonly isZh: boolean;
  /** 工作台卡片点击后要聚焦的 shell taskId（不含 shell: 前缀）。 */
  readonly focusTaskId?: string | null;
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
  const [stopError, setStopError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const listed = await clientApi.listShellTasks();
      const next = backgroundTaskList(listed);
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
    setStopError(null);
    try {
      const result = await clientApi.stopShellTask(taskId);
      if (result.stopped !== true) {
        throw new Error(String(result.reason ?? (isZh ? '未能停止任务' : 'Could not stop task')));
      }
      await reload();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [isZh, reload]);

  if (tasks.length === 0) {
    return (
      <div className="workbench-empty bg-threads-empty">
        <div className="workbench-empty-title">
          {isZh ? '暂无后台任务' : 'No background tasks'}
        </div>
        <p className="workbench-empty-hint">
          {isZh
            ? 'Peer 托管的后台服务和命令会显示在这里。全局可见，不随会话切换停止。'
            : 'Peer-managed background services and commands appear here, across conversations.'}
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
              <span className="bg-threads-item-status">{backgroundTaskStatus(task, isZh)}</span>
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
                  {backgroundTaskStatus(selected, isZh)}
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
            <label className="bg-threads-field">
              <span>{isZh ? '来源会话（仅作追溯）' : 'Source conversation (provenance only)'}</span>
              <pre>{selected.conversationId || (isZh ? '无来源会话' : 'No source conversation')}</pre>
            </label>
            <label className="bg-threads-field">
              <span>{isZh ? '工具调用' : 'Tool call'}</span>
              <pre>{selected.toolCallId || '—'}</pre>
            </label>
            <label className="bg-threads-field">
              <span>{isZh ? 'TCP 监听地址（不代表 HTTP 就绪）' : 'TCP listeners (not HTTP readiness)'}</span>
              <pre>{backgroundTaskAddresses(selected).join('\n') || (isZh ? '暂无已观测的监听地址' : 'No observed listener')}</pre>
            </label>
            <label className="bg-threads-field">
              <span>{isZh ? '日志证据' : 'Log evidence'}</span>
              <pre>{selected.artifactRef || (isZh ? '任务结束后保存；下方为实时日志尾部' : 'Saved on completion; live log tails below')}</pre>
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
            {stopError ? <p className="bg-threads-error" role="alert">{stopError}</p> : null}
            {error ? <p className="bg-threads-error" role="alert">{error}</p> : null}
          </>
        ) : (
          <div className="workbench-empty">
            <div className="workbench-empty-title">
              {isZh ? '选择一个后台任务' : 'Select a background task'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
