import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotModelViews, BotProfile, ModelRoutingMenuOption, ProjectModelPolicy } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

export function useBotModels(workspaceId: string | null, profile: BotProfile | null, onProfile: (profile: BotProfile) => void) {
  const [data, setData] = useState<{ workspaceId: string | null; models: readonly ModelRoutingMenuOption[]; views: BotModelViews }>({ workspaceId: null, models: [], views: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0), saving = useRef(false);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    if (!workspaceId) return;
    try {
      const result = await clientApi.projectAgentGet({ workspaceId });
      if (ticket !== sequence.current) return;
      if (!result.ok) { setError(result.code || 'FAILED'); return; }
      setData({ workspaceId, models: result.modelOptions ?? [], views: result.modelViews ?? {} });
      setError('');
    } catch { if (ticket === sequence.current) setError('FAILED'); }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
    const off = clientApi.onProjectAgentChanged(event => {
      if (workspaceId && (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId))) void refresh();
    });
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    return () => { sequence.current++; off?.(); window.removeEventListener('focus', focused); };
  }, [workspaceId, profile?.modelPolicy, refresh]);

  const save = async (modelPolicy: ProjectModelPolicy) => {
    if (saving.current || !workspaceId) return;
    saving.current = true; setBusy(true); setError('');
    const ticket = sequence.current;
    try {
      const result = await clientApi.projectAgentUpdateProfile({ workspaceId, modelPolicy });
      if (!result.ok || !result.profile) { if (ticket === sequence.current) setError(result.code || 'FAILED'); return; }
      onProfile(result.profile);
      await refresh();
    } catch { if (ticket === sequence.current) setError('FAILED'); }
    finally { saving.current = false; setBusy(false); }
  };
  return { models: data.workspaceId === workspaceId ? data.models : [], views: data.workspaceId === workspaceId ? data.views : {} as BotModelViews, busy, error, save };
}

export type BotModelsControlState = ReturnType<typeof useBotModels>;
