import type { BootstrapPreloadApi } from '../preload/contracts/bootstrapPreloadApi';
type Result = Awaited<ReturnType<BootstrapPreloadApi['gitDiffRange']>>;
export function sameComparisonSnapshot(a: Result, b: Result) {
  return a.workspaceRoot === b.workspaceRoot && a.fromRef === b.fromRef && a.toRef === b.toRef && a.diffText === b.diffText
    && JSON.stringify(a.untracked ?? []) === JSON.stringify(b.untracked ?? []) && a.untrackedTruncated === b.untrackedTruncated;
}
/** One accepted comparison plus a candidate. Observation never silently replaces current reading. */
export function createComparisonRefreshReader(read: () => Promise<Result>) {
  let generation = 0, pending: Promise<boolean> | null = null;
  let state: { value: Result | null; candidate: Result | null; failure: Result | null; loaded: boolean; loading: boolean; error: boolean } = {
    value: null, candidate: null, failure: null, loaded: false, loading: false, error: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const load = (adopt: boolean) => {
    if (pending) return pending;
    const ticket = ++generation; publish({ loading: true });
    const request = Promise.resolve().then(() => ticket === generation ? read() : null).then(result => {
      if (!result || ticket !== generation) return false;
      if (!result.ok) { publish({ failure: result, error: true, loaded: true, loading: false, candidate: null }); return false; }
      const sameSource = typeof result.workspaceRoot === 'string' && result.workspaceRoot.length > 0
        && (!state.value || state.value.workspaceRoot === result.workspaceRoot);
      if (!sameSource) { publish({ error: true, failure: { ...result, ok: false, status: 'error', error: 'workspace_unavailable', diffText: '' }, loaded: true, loading: false, candidate: null }); return false; }
      if (adopt || !state.value) publish({ value: result, candidate: null, failure: null, loaded: true, loading: false, error: false });
      else publish({ candidate: sameComparisonSnapshot(state.value, result) ? null : result, failure: null, loaded: true, loading: false, error: false });
      return true;
    }).catch(() => { if (ticket === generation) publish({ failure: null, error: true, loaded: true, loading: false, candidate: null }); return false; })
      .finally(() => { if (pending === request) pending = null; });
    pending = request; return request;
  };
  return { snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: () => load(true), observe: () => load(false), adopt() { if (!state.loading && state.candidate && !state.error) publish({ value: state.candidate, candidate: null }); },
    cancel() { generation++; pending = null; publish({ loading: false }); } };
}
