import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createProjectInputRecovery, type InputRecoveryView, type ProjectInputRecovery } from '@peer-agent/runtime-core';
import type { LocalInputSurface } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { createInputRecoveryProjection } from './inputRecoveryProjection';

const sessions = new Map<string, ProjectInputRecovery>();
/** Sessions outlive mounted composers; late receipts always retain their original target. */
export function inputRecoveryFor(workspaceId: string, surface: LocalInputSurface = 'desktop') {
  const key = `${surface}:${workspaceId}`;
  let session = sessions.get(key);
  if (!session) {
    session = createProjectInputRecovery({ workspaceId, surface, createId: () => crypto.randomUUID(), port: {
      read: request => clientApi.projectAgentReadInputDraft(request),
      write: request => clientApi.projectAgentWriteInputDraft(request),
      submit: request => clientApi.projectAgentSubmitInput(request),
    } });
    sessions.set(key, session);
  }
  return session;
}
export function useInputRecoverySession(workspaceId: string, surface: LocalInputSurface = 'desktop') {
  const session = inputRecoveryFor(workspaceId, surface);
  useEffect(() => { if (workspaceId && !session.getSnapshot().ready) void session.load(); return () => { void session.flush(); }; }, [session]);
  return session;
}
export function useInputRecoveryState<Key extends keyof InputRecoveryView>(session: ProjectInputRecovery, keys: readonly Key[]) {
  const snapshot = useMemo(() => createInputRecoveryProjection(session.getSnapshot, keys), [session, keys]);
  return useSyncExternalStore(session.subscribe, snapshot);
}
export function useInputRecovery(workspaceId: string, surface: LocalInputSurface = 'desktop') {
  const session = useInputRecoverySession(workspaceId, surface);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { session, state };
}
