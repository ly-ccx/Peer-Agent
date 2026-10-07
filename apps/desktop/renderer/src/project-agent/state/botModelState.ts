import type { BotProfile, ProjectModelPolicy } from '@peer-agent/protocol';
import type { ClientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh.ts';

type Details = Awaited<ReturnType<ClientApi['projectAgentGet']>>;
type Saved = Awaited<ReturnType<ClientApi['projectAgentUpdateProfile']>>;

/** Share only a pending read. Settled facts are never cached across notifications. */
export function createBotDetailsReader<T>(read: (workspaceId: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (workspaceId: string): Promise<T> => {
    const existing = pending.get(workspaceId);
    if (existing) return existing;
    const request = Promise.resolve().then(() => read(workspaceId)).finally(() => {
      if (pending.get(workspaceId) === request) pending.delete(workspaceId);
    });
    pending.set(workspaceId, request);
    return request;
  };
}

export function botModelPolicyKey(policy: ProjectModelPolicy | null | undefined): string {
  return JSON.stringify(policy ?? {}, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
}

/** A saved profile is the commit. A catalogue refresh must not extend the write lock. */
export function createBotModelState(ports: {
  read: () => Promise<Details>;
  write: (policy: ProjectModelPolicy) => Promise<Saved>;
  policy: () => ProjectModelPolicy | null | undefined;
  onData: (result: Details) => void;
  onProfile: (profile: BotProfile) => void;
  onBusy: (busy: boolean) => void;
  onReadError: (error: string) => void;
  onSaveError: (error: string) => void;
}) {
  let stopped = false, saving = false;
  const refresh = createConversationRefresh(async () => {
    try {
      const result = await ports.read();
      if (stopped) return;
      if (!result.ok) { ports.onReadError(result.code || 'FAILED'); return; }
      ports.onData(result);
      ports.onReadError('');
    } catch { if (!stopped) ports.onReadError('FAILED'); }
  });
  return {
    refresh: refresh.request,
    async save(policy: ProjectModelPolicy) {
      if (stopped || saving) return;
      ports.onSaveError('');
      if (botModelPolicyKey(policy) === botModelPolicyKey(ports.policy())) return;
      saving = true; ports.onBusy(true);
      try {
        const result = await ports.write(policy);
        if (stopped) return;
        if (!result.ok || !result.profile) { ports.onSaveError(result.code || 'FAILED'); return; }
        ports.onProfile(result.profile);
        void refresh.request();
      } catch { if (!stopped) ports.onSaveError('FAILED'); }
      finally { saving = false; if (!stopped) ports.onBusy(false); }
    },
    stop() { stopped = true; refresh.stop(); },
  };
}
