import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { canCancelTask } from './botWorkState';
import { taskCancellationFocus } from './taskCancellationFocus';
import '../styles/bot-task-cancel.css';

type CancellationState = { readonly pending: boolean; readonly failed: boolean };
const TaskCancellation = createContext<{
  readonly workspaceId: string | null;
  readonly states: Readonly<Record<string, CancellationState>>;
  readonly cancel: (sessionId: string) => Promise<boolean>;
} | null>(null);

/** Shares pending receipts across the chat and drawer; the host owns cancellation truth. */
export function TaskCancellationProvider({ workspaceId, onRefresh, children }: {
  readonly workspaceId: string | null;
  readonly onRefresh: () => Promise<void>;
  readonly children: ReactNode;
}) {
  const pending = useRef(new Set<string>());
  const [states, setStates] = useState<Readonly<Record<string, CancellationState>>>({});
  async function cancel(sessionId: string) {
    const key = `${workspaceId}:${sessionId}`;
    if (!workspaceId || pending.current.has(key)) return false;
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

export function TaskCancelButton({ sessionId, status, title, i18n }: {
  readonly sessionId: string; readonly status: string | null; readonly title: string; readonly i18n: I18nRuntime;
}) {
  const control = useContext(TaskCancellation);
  if (!control || !canCancelTask(status) && status !== 'stopping') return null;
  const state = control.states[`${control.workspaceId}:${sessionId}`];
  const stopping=state?.pending || status==='stopping';
  return <div className="bot-task-cancel">
    <button type="button" disabled={stopping} aria-busy={stopping}
      aria-label={`${i18n.t('projectAgent.task.cancel')} ${title}`} onClick={async event => {
        const finishFocus = taskCancellationFocus(event.currentTarget);
        try { finishFocus(await control.cancel(sessionId)); }
        catch { finishFocus(false); }
      }}><PeerIcon name="stop" size={13} />{i18n.t(stopping ? 'projectAgent.task.cancelling' : 'projectAgent.task.cancel')}</button>
    {state?.failed && <p role="alert">{i18n.t('projectAgent.task.cancelFailed')}</p>}
  </div>;
}
