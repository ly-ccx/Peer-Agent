import { useEffect, useRef, useState } from 'react';
import type { ManagedShellTask } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';
import { reconcileStopRequest, type StopRequest } from './backgroundRuntimeState';

/** Request feedback lives with the footer, not the transient panel. Never writes run status. */
export function useBackgroundRunStops(snapshot: readonly ManagedShellTask[] | null, reload: () => Promise<void>, isZh: boolean) {
  const [requests, setRequests] = useState<Readonly<Record<string, StopRequest>>>({});
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const pending = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; timers.current.forEach(clearTimeout); };
  }, []);
  useEffect(() => {
    if (snapshot === null) return;
    setRequests((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([, request]) => reconcileStopRequest(request, snapshot)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [snapshot]);
  const publish = (request: StopRequest) => {
    if (!mounted.current) return;
    setRequests((current) => {
      const next = { ...current };
      if (reconcileStopRequest(request, latest.current ?? [])) next[request.taskId] = request;
      else delete next[request.taskId];
      return next;
    });
  };
  const stop = async (taskId: string) => {
    const task = latest.current?.find((run) => run.taskId === taskId && run.runInBackground);
    if (task?.status !== 'running' || pending.current.has(taskId)
      || requests[taskId]?.phase === 'unconfirmed') return;
    pending.current.add(taskId);
    publish({ taskId, phase: 'requesting' });
    const timer = setTimeout(() => publish({ taskId, phase: 'unconfirmed' }), 5000);
    timers.current.add(timer);
    try {
      const result = await clientApi.stopShellTask(taskId);
      publish(result.stopped === true ? { taskId, phase: 'unconfirmed' } : {
        taskId, phase: 'rejected', error: typeof result.reason === 'string' ? result.reason
          : (isZh ? '停止请求被拒绝' : 'Stop request rejected'),
      });
    } catch (error) {
      publish({ taskId, phase: 'rejected', error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      timers.current.delete(timer);
      pending.current.delete(taskId);
      void reload();
    }
  };
  return { requests, stop };
}

export type BackgroundRunStops = ReturnType<typeof useBackgroundRunStops>;
