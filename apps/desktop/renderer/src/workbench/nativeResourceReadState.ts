import type { ResourceWindowReadRequest, ResourceWindowReadResult } from '@peer-agent/protocol';
import { normalizeDocumentObservation } from './documentObservationState.ts';

/** No polling or automatic adoption. A failed refresh retains the accepted reading. */
export function createNativeResourceReader(request: ResourceWindowReadRequest,
  read: (request: ResourceWindowReadRequest) => Promise<ResourceWindowReadResult>) {
  let generation = 0;
  let state: { value: ResourceWindowReadResult | null; failure: string | null; loading: boolean; loaded: boolean } = {
    value: null, failure: null, loading: false, loaded: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const load = async (loadCurrent = false) => {
    const ticket = ++generation;
    const previous = state.value?.document?.observation;
    const expected = previous ? { resourceId: previous.resourceId, ...(!loadCurrent ? { contentVersion: previous.contentVersion } : {}) } : undefined;
    publish({ loading: true, failure: null });
    try {
      const result = await read({ ...request, ...(expected ? { expectedObservation: expected } : {}), ...(loadCurrent ? { loadCurrent: true } : {}) });
      if (ticket !== generation) return false;
      const observed = normalizeDocumentObservation(result.document?.observation);
      const failure = !result.ok ? result.status : request.operation === 'content' && (!result.document?.ok || !observed) ? 'version_unavailable'
        : (request.operation === 'directory' && !Array.isArray(result.directory?.entries) || request.operation === 'diff' && typeof result.diff?.diffText !== 'string') ? 'source_unavailable'
        : expected && observed?.resourceId !== expected.resourceId ? 'source_changed'
          : expected?.contentVersion && observed?.contentVersion !== expected.contentVersion ? 'version_changed' : null;
      if (failure) { publish({ failure, loading: false, loaded: true }); return false; }
      publish({ value: result, failure: null, loading: false, loaded: true }); return true;
    } catch {
      if (ticket === generation) publish({ failure: 'source_unavailable', loading: false, loaded: true });
      return false;
    }
  };
  return { snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload: () => load(), loadCurrent: () => load(true), cancel() { generation++; publish({ loading: false }); } };
}
