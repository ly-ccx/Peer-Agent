import type { BotDocumentReference, LocalDocumentObservation } from '@peer-agent/protocol';

const version = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

export function normalizeDocumentObservation(raw: unknown): LocalDocumentObservation | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (!version(value.sourceId) || !version(value.resourceId) || !version(value.contentVersion)
    || typeof value.relativePath !== 'string' || !value.relativePath || value.relativePath.length > 8192
    || /[\u0000-\u001f]/.test(value.relativePath) || /^(?:[\\/]|[a-z]:[\\/])/i.test(value.relativePath)
    || value.relativePath.split(/[\\/]/).includes('..')) return;
  return { sourceId: value.sourceId, resourceId: value.resourceId, contentVersion: value.contentVersion, relativePath: value.relativePath };
}

export interface ObservedDocumentRead {
  readonly ok: boolean;
  readonly status: string;
  readonly observation?: LocalDocumentObservation;
  readonly resolvedPath?: string;
  readonly content?: string;
  readonly dataUrl?: string;
  readonly media?: 'text' | 'image';
  readonly candidates?: readonly { readonly path: string; readonly root: string }[];
}

/** An accepted in-memory reading is distinct from an observation that newer bytes exist. */
export function createDocumentVersionReader<T extends ObservedDocumentRead>(
  read: (expected: BotDocumentReference['expectedObservation'], isCurrent: () => boolean) => Promise<T>, initial?: LocalDocumentObservation,
) {
  let generation = 0;
  let state: { value: T | null; failure: T | null; loaded: boolean; loading: boolean; error: boolean } = {
    value: null, failure: null, loaded: false, loading: false, error: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const load = async (adoptCurrent: boolean) => {
    const ticket = ++generation;
    const previous = state.value?.observation ?? initial;
    const expected = previous ? { resourceId: previous.resourceId, ...(!adoptCurrent ? { contentVersion: previous.contentVersion } : {}) } : undefined;
    publish({ loading: true, error: false });
    try {
      let result = await read(expected, () => ticket === generation);
      if (ticket !== generation) return false;
      if (result.ok) {
        const observed = normalizeDocumentObservation(result.observation);
        const status = !observed ? 'version_unavailable' : expected && observed.resourceId !== expected.resourceId ? 'source_changed'
          : expected?.contentVersion && observed.contentVersion !== expected.contentVersion ? 'version_changed' : 'ok';
        if (status !== 'ok') result = { ...result, ok: false, status, content: '', dataUrl: '' };
      }
      if (!result.ok) { publish({ failure: result, loaded: true, loading: false }); return false; }
      publish({ value: result, failure: null, loaded: true, loading: false }); return true;
    } catch {
      if (ticket === generation) publish({ loaded: true, loading: false, error: true });
      return false;
    }
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel() { generation++; publish({ loading: false }); },
    reload: () => load(false),
    loadCurrent: () => load(true),
  };
}
