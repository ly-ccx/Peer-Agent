import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { PeerIcon } from '../../ui/icons';
import { canCancelTask } from './botWorkState';
import { isAwaitingBotReport, isTaskStatusSpinning, type TaskStatusFacts } from './drawerState';
import { taskCancellationFocus } from './taskCancellationFocus';
import '../styles/bot-task-cancel.css';

type CancellationState = { readonly pending: boolean; readonly failed: boolean };
type CancellationTask = TaskStatusFacts & { readonly sessionId: string; readonly title: string; readonly cancelable?: boolean };
const TaskCancellation = createContext<{
  readonly workspaceId: string | null;
  readonly states: Readonly<Record<string, CancellationState>>;
  readonly cancel: (task: CancellationTask, i18n: I18nRuntime) => Promise<boolean>;
} | null>(null);

/** Shares pending receipts across the chat and drawer; the host owns cancellation truth. */
export function TaskCancellationProvider({ workspaceId, onRefresh, children }: {
  readonly workspaceId: string | null;
  readonly onRefresh: () => Promise<void>;
  readonly children: ReactNode;
}) {
  const pending = useRef(new Set<string>());
  const confirm = useConfirm();
  const confirming = useRef(false);
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const [states, setStates] = useState<Readonly<Record<string, CancellationState>>>({});
  async function cancel(task: CancellationTask, i18n: I18nRuntime) {
    const { sessionId, title, cancelable, status } = task;
    const key = `${workspaceId}:${sessionId}`;
    if (!workspaceId || !canCancelTask(status, cancelable) || pending.current.has(key)) return false;
    if (isAwaitingBotReport(task)) {
      if (confirming.current) return false;
      confirming.current = true;
      try {
        if (!await confirm({
          title: i18n.t('projectAgent.task.withdrawTitle'),
          message: i18n.t('projectAgent.task.withdrawConfirm', { title }),
          confirmText: i18n.t('projectAgent.task.withdraw'),
          cancelText: i18n.t('projectAgent.task.keep'),
          tone: 'danger',
        }) || currentWorkspace.current !== workspaceId || pending.current.has(key)) return false;
      } finally {
        confirming.current = false;
      }
    }
    pending.current.add(key);
    setStates(current => ({ ...current, [key]: { pending: true, failed: false } }));
    let failed = false;
    try {
      const result = await clientApi.projectAgentCancelSession({ workspaceId, sessionId, reason: 'user_cancelled' });
      if (!result.ok) throw new Error('Cancellation incomplete');
      await onRefresh();
      return true;
    } catch {
      failed = true;
      await onRefresh();
      return false;
    } finally {
      pending.current.delete(key);
      setStates(current => ({ ...current, [key]: { pending: false, failed } }));
    }
  }
  return <TaskCancellation.Provider value={{ workspaceId, states, cancel }}>{children}</TaskCancellation.Provider>;
}

export function useTaskCancellation() {
  return useContext(TaskCancellation);
}

export function TaskCancelButton({ task, i18n }: {
  readonly task: CancellationTask;
  readonly i18n: I18nRuntime;
}) {
  const control = useContext(TaskCancellation);
  const { sessionId, status, cancelable, title } = task;
  // 停止中的按钮只表达"正在停止"，其余一律听生命周期决策的 cancelable。
  if (!control || (!canCancelTask(status, cancelable) && status !== 'stopping')) return null;
  const state = control.states[`${control.workspaceId}:${sessionId}`];
  const stopping = state?.pending || status === 'stopping';
  const withdrawing = isAwaitingBotReport(task);
  const stopAction = status === 'stopping' || isTaskStatusSpinning(task);
  const actionTitle = i18n.t(withdrawing ? 'projectAgent.task.withdrawTitle' : stopAction ? 'chat.thread.stop' : 'projectAgent.task.cancel');
  const label = withdrawing
    ? i18n.t(stopping ? 'projectAgent.task.withdrawing' : 'projectAgent.task.withdraw')
    : stopping ? i18n.t(stopAction ? 'projectAgent.task.stopping' : 'projectAgent.task.cancelling') : actionTitle;
  return <div className="bot-task-cancel">
    <button type="button" disabled={stopping} aria-busy={stopping}
      title={withdrawing ? actionTitle : undefined} aria-label={`${actionTitle} ${title}`} onClick={async event => {
        const finishFocus = taskCancellationFocus(event.currentTarget);
        try { finishFocus(await control.cancel(task, i18n)); }
        catch { finishFocus(false); }
      }}><PeerIcon name={withdrawing ? 'close' : 'stop'} size={13} />{label}</button>
    {state?.failed && <p role="alert">{i18n.t(withdrawing ? 'projectAgent.task.withdrawFailed' : 'projectAgent.task.cancelFailed')}</p>}
  </div>;
}
