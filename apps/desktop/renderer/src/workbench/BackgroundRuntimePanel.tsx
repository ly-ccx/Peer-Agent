import { createI18n } from '@peer-agent/i18n';
import { PeerIcon } from '../ui/icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ManagedShellTask } from '@peer-agent/protocol';
import type { BackgroundRunStops } from './useBackgroundRunStops';
import { Overlay } from '../app/components/Overlay';
import { BackgroundRunDetails } from './BackgroundRunDetails';
import { backgroundTaskStatus } from './backgroundTaskPresentation';
import { backgroundReadPresentation, backgroundRunSource, isActiveRun, isFailedRun, orderBackgroundRuns, reconcileStopRequest, visibleBackgroundRuns, type StopRequest } from './backgroundRuntimeState';

export function BackgroundRuntimePanel({ anchor, snapshot, error, reload, sources, onSource, isZh, onClose, id, stops, initialTaskId = null }: {
  readonly stops: BackgroundRunStops;
  readonly anchor: HTMLElement;
  readonly snapshot: readonly ManagedShellTask[] | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly sources: readonly { id: string; title: string }[] | null;
  readonly onSource?: (id: string) => void;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly id: string;
  /** 由外部（任务上下文栏）指定要直接展开的运行；仍走同一个详情视图。 */
  readonly initialTaskId?: string | null;
}) {
  let locale = 'en-US';
  if (isZh) locale = 'zh-CN';
  const i18n = createI18n(locale);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const listScroll = useRef(0);
  const lastRow = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = document.getElementById(id);
    if (!panel) return;
    if (selected) {
      panel.scrollTop = 0;
      panel.focus({ preventScroll: true });
    } else if (lastRow.current) {
      const row = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-run-id]') ?? [])
        .find((node) => node.dataset.runId === lastRow.current);
      row?.focus({ preventScroll: true });
      panel.scrollTop = listScroll.current;
    }
  }, [selected, id]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [confirmation, setRequest] = useState<StopRequest | null>(null);
  const request = confirmation ?? (selected ? stops.requests[selected] ?? null : null);
  const order = useRef<string[]>([]);
  const pinned = useRef<string[]>([]);
  const runs = orderBackgroundRuns(snapshot ?? [], order.current);
  useEffect(() => {
    order.current = runs.map((run) => run.taskId);
    pinned.current = Array.from(new Set([...pinned.current, ...runs.filter((run) => isActiveRun(run) || isFailedRun(run)).map((run) => run.taskId)]));
    setRequest((current) => reconcileStopRequest(current, runs));
  }, [snapshot]);
  const visible = visibleBackgroundRuns(runs, pinned.current, historyOpen, historyLimit);
  const task = runs.find((run) => run.taskId === selected);
  const readState = backgroundReadPresentation(snapshot !== null, error);
  const stop = () => {
    if (!task || task.status !== 'running' || confirmation?.taskId !== task.taskId) return;
    setRequest(null);
    void stops.stop(task.taskId);
  };
  const row = (run: ManagedShellTask) => <button type="button" className="background-run-row" data-run-id={run.taskId} key={run.taskId} onClick={() => {
    listScroll.current = document.getElementById(id)?.scrollTop ?? 0;
    lastRow.current = run.taskId;
    setSelected(run.taskId);
  }}>
    <span className="background-run-row-heading"><span>{run.description?.trim() || run.command}</span><small>{backgroundTaskStatus(run, isZh)}</small></span>
    <span className="background-run-meta">{backgroundRunSource(run, sources, isZh).label} · {(run.cwd ?? '').split(/[\\/]/).filter(Boolean).pop()}</span>
  </button>;
  return <Overlay anchor={anchor} id={id} ariaLabel={i18n.t('projectAgent.background.title')} panelClassName="background-runtime-panel" onClose={onClose}
    onEscape={() => { if (request?.phase === 'confirm') { setRequest(null); return true; } return false; }}>
    {({ requestClose }) => <>
      <header className="background-runtime-header" data-testid="background-runtime-state" data-read-state={readState}>
        {selected ? <button type="button" onClick={() => { setRequest(null); setSelected(null); }}><PeerIcon name="back" size={14} /> {i18n.t('projectAgent.background.title')}</button> : <h2>{i18n.t('projectAgent.background.title')}</h2>}
        <span className="background-run-meta">{i18n.t('projectAgent.background.device')}</span>
        <button type="button" aria-label={i18n.t('projectAgent.background.close')} onClick={requestClose}><PeerIcon name="close" size={14} /></button>
      </header>
      {(readState === 'error' || readState === 'stale') && <p role="alert">{i18n.t('projectAgent.background.readFailed')}{readState === 'stale' ? (i18n.t('projectAgent.background.previous')) : ''}<button type="button" onClick={() => void reload()}>{i18n.t('projectAgent.background.retry')}</button></p>}
      {readState === 'loading' ? <p role="status">{i18n.t('projectAgent.background.loading')}</p> : selected ? task
        ? <BackgroundRunDetails key={task.taskId} task={task} sources={sources} isZh={isZh} request={request?.taskId === task.taskId ? request : null}
          onConfirm={() => setRequest({ taskId: task.taskId, phase: 'confirm' })} onCancel={() => setRequest(null)} onStop={() => void stop()}
          onSource={onSource ? (sourceId) => { onClose(); onSource(sourceId); } : undefined} />
        : <p>{i18n.t('projectAgent.background.unavailable')}</p>
        : <div ref={list} className="background-runtime-list">
          {visible.primary.map(row)}
          {snapshot !== null && !runs.length && !error && <p>{i18n.t('projectAgent.background.empty')}</p>}
          {visible.historyCount > 0 && <><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{i18n.t('projectAgent.background.history')} ({visible.historyCount})</button>
            {visible.history.map(row)}
            {historyOpen && historyLimit < visible.historyCount && <button type="button" onClick={() => setHistoryLimit(historyLimit + 20)}>{i18n.t('projectAgent.background.more')}</button>}</>}
        </div>}
      {request?.phase === 'unconfirmed' && <button type="button" onClick={() => void reload()}>{i18n.t('projectAgent.background.refresh')}</button>}
    </>}
  </Overlay>;
}
