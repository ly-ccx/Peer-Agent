import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelReasoningEffort, ProjectModelPolicy } from '@peer-agent/protocol';
import type { ClientApi } from '../../clientApi';
import { clientApi } from '../../clientApi';
import { readBotDetails } from './botDetails';
import { createBotModelState } from './botModelState';
import { botConfiguredModelSelection, botFixedModelPolicy } from './botModelControls';

type Details = Awaited<ReturnType<ClientApi['projectAgentGet']>>;

/** Quick Chat edits the selected Bot's existing policy, which the host uses on submission. */
export function useQuickChatBotModel(workspaceId: string | null) {
  const [data, setData] = useState<{ workspaceId: string; details: Details } | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const stateRef = useRef<ReturnType<typeof createBotModelState> | null>(null);
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    setBusy(false); setReadError(''); setSaveError('');
    if (!workspaceId) return;
    const state = createBotModelState({
      read: () => readBotDetails(workspaceId),
      write: modelPolicy => {
        const choice = modelPolicy.overrides?.project_agent;
        return choice?.mode === 'fixed'
          ? clientApi.projectAgentUpdateModelSelection({ workspaceId, modelProviderId: choice.modelProviderId, reasoningEffort: choice.reasoningEffort })
          : Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
      },
      policy: () => latest.current?.workspaceId === workspaceId ? latest.current.details.profile?.modelPolicy : undefined,
      onData: details => setData({ workspaceId, details: { ...details, profile: details.profile ?? details.item?.profile } }),
      onProfile: profile => setData(current => current?.workspaceId === workspaceId
        ? { ...current, details: { ...current.details, profile } } : current),
      onBusy: setBusy, onReadError: setReadError, onSaveError: setSaveError,
    });
    stateRef.current = state;
    void state.refresh();
    const off = clientApi.onProjectAgentChanged(event => {
      if (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId)) void state.refresh();
    });
    const shown = clientApi.onQuickChatShown?.(() => void state.refresh());
    return () => {
      state.stop(); if (stateRef.current === state) stateRef.current = null;
      off?.(); shown?.();
    };
  }, [workspaceId]);

  const save = useCallback((policy: ProjectModelPolicy) => stateRef.current?.save(policy) ?? Promise.resolve(), []);
  const details = data?.workspaceId === workspaceId ? data.details : null;
  const models = details?.modelOptions ?? [];
  const view = details?.modelViews?.project_agent;
  const policy = details?.profile?.modelPolicy;
  const selection = botConfiguredModelSelection(policy, 'project_agent', models, view)
    ?? (view?.resolution.ok ? view.resolution.selection : undefined);
  const model = models.find(item => item.id === selection?.modelProviderId);
  const effort = selection?.reasoningEffort ?? model?.defaultReasoningEffort;
  const choices = models.filter(item => item.available && view?.eligibleModelIds.includes(item.id));
  return {
    model, effort, choices, busy, error: saveError || readError, saveFailed: Boolean(saveError),
    ready: Boolean(details?.ok && model && choices.some(item => item.id === model.id)),
    chooseModel: (id: string) => {
      const next = choices.find(item => item.id === id);
      if (next) void save(botFixedModelPolicy(policy, 'project_agent', next, effort));
    },
    chooseEffort: (value: string) => {
      if (model?.reasoningEffortLevels?.includes(value as ModelReasoningEffort)) {
        void save(botFixedModelPolicy(policy, 'project_agent', model, value));
      }
    },
  };
}
