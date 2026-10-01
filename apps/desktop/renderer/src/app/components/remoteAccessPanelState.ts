import type { BotListItem, RemoteProjectGrant } from '@peer-agent/protocol';
import type { RemoteAccessIpcResult, RemoteAccessPatch } from '../../preload/contracts/bootstrapPreloadApi';
import type { Status } from './remoteAccessPresentation';

/** A complete policy replacement preserves grants for bots absent from this view. */
export function changeProjectGrant(grants: readonly RemoteProjectGrant[], workspaceId: string,
  permission: 'read' | 'message', checked: boolean): readonly RemoteProjectGrant[] {
  const current = grants.find(row => row.workspaceId === workspaceId)
    ?? { workspaceId, allowProjectRead: false, allowProjectMessage: false };
  const next = permission === 'read'
    ? { ...current, allowProjectRead: checked, allowProjectMessage: checked && current.allowProjectMessage }
    : { ...current, allowProjectMessage: checked && current.allowProjectRead };
  return [...grants.filter(row => row.workspaceId !== workspaceId), next];
}

interface Ports {
  getRemoteAccess(): Promise<RemoteAccessIpcResult>;
  updateRemoteAccess(patch: RemoteAccessPatch): Promise<RemoteAccessIpcResult>;
  applyRemoteAccess(): Promise<RemoteAccessIpcResult>;
  projectAgentList(): Promise<{ ok: boolean; items?: readonly BotListItem[] }>;
}
interface Snapshot {
  status: Status | null;
  bots: readonly BotListItem[];
  error: string | null;
  listFailed: boolean;
  busy: boolean;
}

/** Owns asynchronous admission for this panel. A mutation invalidates all old
 * reads; polls cannot race a save, and disposal invalidates every pending result. */
export function createRemoteAccessPanelState(ports: Ports) {
  let snapshot: Snapshot = { status: null, bots: [], error: null, listFailed: false, busy: false };
  let active = false, generation = 0, lifetime = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  async function refresh() {
    if (!active || snapshot.busy) return;
    const token = ++generation;
    try {
      const result = await ports.getRemoteAccess();
      if (!active || token !== generation) return;
      if (result.ok && result.status) publish({ status: result.status });
      else publish({ error: result.error ?? 'REMOTE_UPDATE_FAILED' });
    } catch {
      if (active && token === generation) publish({ error: 'REMOTE_UPDATE_FAILED' });
    }
  }
  async function mutate(run: () => Promise<RemoteAccessIpcResult>) {
    if (!active || snapshot.busy) return;
    const token = ++generation;
    publish({ busy: true, error: null });
    try {
      const result = await run();
      if (!active || token !== generation) return;
      if (result.ok && result.status) publish({ status: result.status });
      else {
        publish({ error: result.error ?? 'REMOTE_UPDATE_FAILED' });
        // The intent may have been persisted before connecting failed.
        const current = await ports.getRemoteAccess();
        if (active && token === generation && current.ok && current.status) publish({ status: current.status });
      }
    } catch {
      if (active && token === generation) publish({ error: 'REMOTE_UPDATE_FAILED' });
    } finally {
      if (active && token === generation) publish({ busy: false });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      active = true;
      const mounted = ++lifetime;
      void refresh();
      void ports.projectAgentList().then(result => {
        if (!active || mounted !== lifetime) return;
        publish({ bots: result.ok ? result.items ?? [] : [], listFailed: !result.ok });
      }, () => { if (active && mounted === lifetime) publish({ listFailed: true }); });
    },
    stop() { active = false; generation += 1; lifetime += 1; },
    refresh,
    update: (patch: RemoteAccessPatch) => mutate(() => ports.updateRemoteAccess(patch)),
    reconnect: () => mutate(() => ports.applyRemoteAccess()),
  };
}
