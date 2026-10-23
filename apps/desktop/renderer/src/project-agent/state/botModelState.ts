import type { BotProfile, ModelRole, ProjectModelPolicy } from '@peer-agent/protocol';
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
  onPending?: (policy: ProjectModelPolicy | null, base?: ProjectModelPolicy | null) => void;
  onReading?: (reading: boolean) => void;
}) {
  let stopped = false, saving = false, revision = 0;
  const refresh = createConversationRefresh(async () => {
    const ticket = revision;
    if (!stopped) ports.onReading?.(true);
    try {
      const result = await ports.read();
      if (stopped || ticket !== revision || saving) return;
      if (!result.ok) { ports.onReadError(result.code || 'FAILED'); return; }
      ports.onData(result);
      ports.onReadError('');
    } catch { if (!stopped && ticket === revision) ports.onReadError('FAILED'); }
    finally { if (!stopped) ports.onReading?.(false); }
  });
  return {
    refresh: refresh.request,
    async save(policy: ProjectModelPolicy, baseline: ProjectModelPolicy | null = ports.policy() ?? null) {
      if (stopped || saving) return false;
      ports.onSaveError('');
      if (botModelPolicyKey(policy) === botModelPolicyKey(baseline)) { ports.onPending?.(null); return true; }
      revision++; ports.onPending?.(policy, baseline);
      saving = true; ports.onBusy(true);
      try {
        const result = await ports.write(policy);
        if (stopped) return false;
        if (!result.ok || !result.profile) { ports.onSaveError(result.code || 'FAILED'); return false; }
        ports.onProfile(result.profile); ports.onPending?.(null);
        void refresh.request(); return true;
      } catch { if (!stopped) ports.onSaveError('FAILED'); return false; }
      finally { saving = false; if (!stopped) ports.onBusy(false); }
    },
    stop() { stopped = true; refresh.stop(); },
  };
}

/** Retry only the edited role/scope fields, retaining newer unrelated saved configuration. */
export function rebaseBotModelPolicy(base: ProjectModelPolicy | null | undefined, desired: ProjectModelPolicy, current: ProjectModelPolicy | null | undefined): ProjectModelPolicy {
  const overrides = { ...current?.overrides };
  for (const role of new Set([...Object.keys(base?.overrides ?? {}), ...Object.keys(desired.overrides ?? {})]) as Set<ModelRole>) {
    if (JSON.stringify(base?.overrides?.[role]) === JSON.stringify(desired.overrides?.[role])) continue;
    if (desired.overrides?.[role]) overrides[role] = desired.overrides[role]; else delete overrides[role];
  }
  const scope = { ...current?.scope };
  for (const key of ['modelProviderIds', 'families', 'localOnly'] as const) {
    if (JSON.stringify(base?.scope?.[key]) === JSON.stringify(desired.scope?.[key])) continue;
    const value = desired.scope?.[key];
    if (value === undefined) delete scope[key];
    else Object.assign(scope, { [key]: value });
  }
  return { ...current, overrides, scope };
}
