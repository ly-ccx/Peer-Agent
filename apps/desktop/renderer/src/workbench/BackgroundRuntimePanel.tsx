import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ManagedShellTask } from '@peer-agent/protocol';
import type { BackgroundRunStops } from './useBackgroundRunStops';
import { Overlay } from '../app/components/Overlay';
import { BackgroundRunDetails } from './BackgroundRunDetails';
import { backgroundTaskStatus } from './backgroundTaskPresentation';
import { backgroundReadPresentation, backgroundRunSource, isActiveRun, isFailedRun, orderBackgroundRuns, reconcileStopRequest, visibleBackgroundRuns, type StopRequest } from './backgroundRuntimeState';

export function BackgroundRuntimePanel({ anchor, snapshot, error, reload, sources, onSource, isZh, onClose, id, stops }: {
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
}) {
  const [selected, setSelected] = useState<string | null>(null);
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
  return <Overlay anchor={anchor} id={id} ariaLabel={isZh ? '后台运行' : 'Background runs'} panelClassName="background-runtime-panel" onClose={onClose}
    onEscape={() => { if (request?.phase === 'confirm') { setRequest(null); return true; } return false; }}>
    {({ requestClose }) => <>
      <header className="background-runtime-header">
        {selected ? <button type="button" onClick={() => { setRequest(null); setSelected(null); }}>‹ {isZh ? '后台运行' : 'Background runs'}</button> : <h2>{isZh ? '后台运行' : 'Background runs'}</h2>}
        <span className="background-run-meta">{isZh ? '本机' : 'This device'}</span>
        <button type="button" aria-label={isZh ? '关闭' : 'Close'} onClick={requestClose}>×</button>
      </header>
      {(readState === 'error' || readState === 'stale') && <p role="alert">{isZh ? '暂时无法读取后台运行' : 'Unable to read background runs'}{readState === 'stale' ? (isZh ? ' · 显示上次结果' : ' · Previous snapshot') : ''}<button type="button" onClick={() => void reload()}>{isZh ? '重试' : 'Retry'}</button></p>}
      {readState === 'loading' ? <p role="status">{isZh ? '正在读取…' : 'Loading…'}</p> : selected ? task
        ? <BackgroundRunDetails key={task.taskId} task={task} sources={sources} isZh={isZh} request={request?.taskId === task.taskId ? request : null}
          onConfirm={() => setRequest({ taskId: task.taskId, phase: 'confirm' })} onCancel={() => setRequest(null)} onStop={() => void stop()}
          onSource={onSource ? (sourceId) => { onClose(); onSource(sourceId); } : undefined} />
        : <p>{isZh ? '此运行记录已不可用' : 'Run record unavailable'}</p>
        : <div ref={list} className="background-runtime-list">
          {visible.primary.map(row)}
          {snapshot !== null && !runs.length && !error && <p>{isZh ? '暂无后台运行' : 'No background runs'}</p>}
          {visible.historyCount > 0 && <><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{isZh ? '最近结束' : 'Recently ended'} ({visible.historyCount})</button>
            {visible.history.map(row)}
            {historyOpen && historyLimit < visible.historyCount && <button type="button" onClick={() => setHistoryLimit(historyLimit + 20)}>{isZh ? '显示更多' : 'Show more'}</button>}</>}
        </div>}
      {request?.phase === 'unconfirmed' && <button type="button" onClick={() => void reload()}>{isZh ? '刷新状态' : 'Refresh status'}</button>}
    </>}
  </Overlay>;
}
