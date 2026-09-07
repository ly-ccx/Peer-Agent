import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { BackgroundRuntimePanel } from './BackgroundRuntimePanel';
import { useBackgroundRuns } from './useBackgroundRuns';
import { useBackgroundRunStops } from './useBackgroundRunStops';
import { isActiveRun, isFailedRun } from './backgroundRuntimeState';

interface BackgroundRunsProps {
  readonly isZh: boolean;
  readonly sources?: readonly { id: string; title: string }[] | null;
  readonly onSource?: (id: string) => void;
}
const BackgroundRunsContext = createContext<(ReturnType<typeof useBackgroundRuns> & BackgroundRunsProps & {
  stops: ReturnType<typeof useBackgroundRunStops>;
  seenFailures: string;
  setSeenFailures: (value: string) => void;
}) | null>(null);

/** Shared presentation state survives conversation/header remounts; Runtime owns run status. */
export function BackgroundRunsProvider({ children, isZh, sources = null, onSource }: BackgroundRunsProps & { children: ReactNode }) {
  const reader = useBackgroundRuns();
  const stops = useBackgroundRunStops(reader.snapshot, reader.reload, isZh);
  const [seenFailures, setSeenFailures] = useState('');
  return <BackgroundRunsContext.Provider value={{ ...reader, stops, isZh, sources, onSource, seenFailures, setSeenFailures }}>{children}</BackgroundRunsContext.Provider>;
}

export function GlobalBackgroundTasksButton() {
  const state = useContext(BackgroundRunsContext);
  return state ? <BackgroundRunsButton state={state} /> : null;
}
function BackgroundRunsButton({ state }: { state: NonNullable<React.ContextType<typeof BackgroundRunsContext>> }) {
  const { snapshot, error, reload, stops, isZh, sources, onSource, seenFailures, setSeenFailures } = state;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const runs = (snapshot ?? []).filter((run) => run.runInBackground);
  const count = runs.filter(isActiveRun).length;
  const failures = runs.filter(isFailedRun).map((run) => run.taskId).sort().join('|');
  const unreadFailure = !open && failures !== '' && failures !== seenFailures;
  const title = isZh ? '后台运行' : 'Background runs';
  return <>
    <button ref={anchor} type="button" className="chat-header-action-btn background-runtime-trigger" title={`${title}${count ? ` · ${count}` : ''}`} aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={`${title}${count ? ` · ${count}` : ''}${unreadFailure ? (isZh ? ' · 有失败的运行' : ' · Failed runs') : ''}`}
      onClick={() => { setSeenFailures(failures); setOpen(!open); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10" /><circle cx="19" cy="18" r="2" />
      </svg>

    </button>
    {open && anchor.current ? <BackgroundRuntimePanel id={id} anchor={anchor.current} snapshot={snapshot} error={error} reload={reload}
      sources={sources ?? null} onSource={onSource} stops={stops} isZh={isZh} onClose={() => { setSeenFailures(failures); setOpen(false); }} /> : null}
  </>;
}
