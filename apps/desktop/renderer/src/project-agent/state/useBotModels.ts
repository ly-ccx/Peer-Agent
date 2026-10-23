import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotModelViews, BotProfile, ModelRoutingMenuOption, ProjectModelPolicy } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { readBotDetails } from './botDetails';
import { createBotModelState, rebaseBotModelPolicy, botModelPolicyKey } from './botModelState';

const pendingPolicies = new Map<string, { policy: ProjectModelPolicy; base: ProjectModelPolicy | null }>();

export function useBotModels(workspaceId: string | null, profile: BotProfile | null, onProfile: (profile: BotProfile) => void) {
  const [data, setData] = useState<{ workspaceId: string | null; models: readonly ModelRoutingMenuOption[]; views: BotModelViews }>({ workspaceId: null, models: [], views: {} });
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<ProjectModelPolicy | null>(null);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const stateRef = useRef<ReturnType<typeof createBotModelState> | null>(null);
  const latest = useRef({ profile, onProfile });
  latest.current = { profile, onProfile };
  useEffect(() => {
    setBusy(false); setReadError(''); setSaveError(''); setReading(Boolean(workspaceId));
    setPending(workspaceId ? pendingPolicies.get(workspaceId)?.policy ?? null : null);
    if (!workspaceId) return;
    const state = createBotModelState({
      read: () => readBotDetails(workspaceId),
      write: modelPolicy => clientApi.projectAgentUpdateProfile({ workspaceId, modelPolicy }),
      policy: () => latest.current.profile?.modelPolicy,
      onData: result => {
        setData({ workspaceId, models: result.modelOptions ?? [], views: result.modelViews ?? {} });
        const draft = pendingPolicies.get(workspaceId);
        if (draft && result.profile && botModelPolicyKey(draft.policy) === botModelPolicyKey(result.profile.modelPolicy)) { pendingPolicies.delete(workspaceId); setPending(null); setSaveError(''); }
      },
      onProfile: profile => latest.current.onProfile(profile),
      onPending: (policy, base) => { setPending(policy); if (policy) pendingPolicies.set(workspaceId, { policy, base: base ?? null }); else pendingPolicies.delete(workspaceId); },
      onReading: setReading,
      onBusy: setBusy, onReadError: setReadError, onSaveError: setSaveError,
    });
    stateRef.current = state;
    void state.refresh();
    const off = clientApi.onProjectAgentChanged(event => {
      if (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId)) void state.refresh();
    });
    const focused = () => void state.refresh();
    window.addEventListener('focus', focused);
    return () => {
      state.stop(); if (stateRef.current === state) stateRef.current = null;
      off?.(); window.removeEventListener('focus', focused);
    };
  }, [workspaceId]);
  const save = useCallback((modelPolicy: ProjectModelPolicy) => stateRef.current?.save(modelPolicy) ?? Promise.resolve(false), []);
  const reload = useCallback(() => stateRef.current?.refresh(), []);
  const retry = () => { const draft = workspaceId ? pendingPolicies.get(workspaceId) : null; return draft ? save(rebaseBotModelPolicy(draft.base, draft.policy, latest.current.profile?.modelPolicy)) : Promise.resolve(false); };
  const discard = () => { if (busy) return; if (workspaceId) pendingPolicies.delete(workspaceId); setPending(null); setSaveError(''); };
  return { loaded: data.workspaceId === workspaceId, reading, readError, saveError, pending, retry, reload, discard, models: data.workspaceId === workspaceId ? data.models : [], views: data.workspaceId === workspaceId ? data.views : {} as BotModelViews, busy, error: saveError || readError, save };
}

export type BotModelsControlState = ReturnType<typeof useBotModels>;
