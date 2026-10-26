import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BotDocumentReference, LocalDocumentObservation } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';
import { detectFileKind } from './file-preview/fileTypes';
import { createDocumentVersionReader, type ObservedDocumentRead } from './documentObservationState';

/** Every read, including adoption, resolves the current scope before requesting exact bytes. */
export async function readObservedDocument(reference: BotDocumentReference, expected?: BotDocumentReference['expectedObservation'], isCurrent = () => true): Promise<ObservedDocumentRead> {
  if (!isCurrent()) return { ok: false, status: 'cancelled' };
  const metadata = await clientApi.readFile('', undefined, undefined, { ...reference, metadataOnly: true });
  if (!isCurrent()) return { ok: false, status: 'cancelled' };
  if (!metadata.ok) return metadata;
  if (!metadata.metadataOnly || !metadata.resolvedPath) return { ok: false, status: 'version_unavailable' };
  if (expected && metadata.identity && metadata.identity.resourceId !== expected.resourceId) return { ok: false, status: 'source_changed' };
  const condition = expected ?? (metadata.identity ? { resourceId: metadata.identity.resourceId } : undefined);
  const exact = { ...reference, path: metadata.resolvedPath, ...(condition ? { expectedObservation: condition } : {}) };
  const image = detectFileKind(exact.path) === 'image';
  const result = image ? await clientApi.readImageDataUrl('', undefined, undefined, exact) : await clientApi.readFile('', undefined, undefined, exact);
  return { ...result, resolvedPath: metadata.resolvedPath, media: image ? 'image' : 'text' };
}

export function useObservedDocument(identity: string, reference: BotDocumentReference, active: boolean,
  initial?: LocalDocumentObservation, onObservation?: (value: LocalDocumentObservation) => void) {
  const ports = useMemo(() => ({ reference, onObservation, active }), [identity]); ports.reference = reference; ports.onObservation = onObservation; ports.active = active;
  const previousPorts = useRef<typeof ports | null>(null);
  if (previousPorts.current !== ports) { if (previousPorts.current) previousPorts.current.active = false; previousPorts.current = ports; }
  const reader = useMemo(() => createDocumentVersionReader((expected, isCurrent) => readObservedDocument(ports.reference, expected, () => ports.active && isCurrent()), initial), [ports]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => {
    if (active && !reader.snapshot().loaded) void reader.reload();
    return () => reader.cancel();
  }, [reader, active]);
  useEffect(() => { if (active && state.value?.observation) ports.onObservation?.(state.value.observation); }, [active, state.value?.observation, ports]);
  return { ...state, reload: reader.reload, loadCurrent: reader.loadCurrent };
}
