import { createContext, useContext, type ReactNode } from 'react';
import { useBackgroundRuns } from './useBackgroundRuns';
import { useBackgroundRunStops } from './useBackgroundRunStops';

interface BackgroundRunsProps {
  readonly isZh: boolean;
  readonly sources?: readonly { id: string; title: string }[] | null;
  readonly onSource?: (id: string) => void;
}
const BackgroundRunsContext = createContext<(ReturnType<typeof useBackgroundRuns> & BackgroundRunsProps & {
  stops: ReturnType<typeof useBackgroundRunStops>;
}) | null>(null);

/**
 * 供「任务上下文栏」等只读投影消费同一份 Runtime 快照。
 * 必须复用 Provider 的单一轮询reader：再起一个 poller 会重复打主进程。
 */
export function useBackgroundRunsContext() {
  return useContext(BackgroundRunsContext);
}

/** Shared presentation state survives conversation/header remounts; Runtime owns run status. */
export function BackgroundRunsProvider({ children, isZh, sources = null, onSource }: BackgroundRunsProps & { children: ReactNode }) {
  const reader = useBackgroundRuns();
  const stops = useBackgroundRunStops(reader.snapshot, reader.reload, isZh);
  return <BackgroundRunsContext.Provider value={{
    ...reader, stops, isZh, sources, onSource,
  }}>{children}</BackgroundRunsContext.Provider>;
}
