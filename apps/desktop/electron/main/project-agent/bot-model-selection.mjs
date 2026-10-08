/** Admit only one eligible project-agent model choice, then use the existing profile commit. */
export function createBotModelSelectionUpdater({ get, updateProfile }) {
  return async function updateModelSelection(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['workspaceId', 'modelProviderId', 'reasoningEffort'].includes(key))
      || typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()
      || typeof payload.modelProviderId !== 'string' || !payload.modelProviderId.trim()
      || (payload.reasoningEffort !== undefined && typeof payload.reasoningEffort !== 'string')) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const result = get({ workspaceId: payload.workspaceId });
    if (!result?.ok) return result;
    const current = result.item?.profile;
    if (!current || current.status === 'archived') return { ok: false, code: 'NOT_FOUND' };
    const model = result.modelOptions?.find(item => item.id === payload.modelProviderId && item.available === true);
    if (!model || !result.modelViews?.project_agent?.eligibleModelIds.includes(model.id)) return { ok: false, code: 'MODEL_UNAVAILABLE' };
    const effort = payload.reasoningEffort ?? model.defaultReasoningEffort;
    if (effort !== undefined && !model.reasoningEffortLevels?.includes(effort)) return { ok: false, code: 'INVALID_EFFORT' };
    const modelPolicy = { ...current.modelPolicy, overrides: { ...current.modelPolicy?.overrides,
      project_agent: { mode: 'fixed', modelProviderId: model.id, ...(effort !== undefined ? { reasoningEffort: effort } : {}) } } };
    return updateProfile({ workspaceId: payload.workspaceId, modelPolicy });
  };
}
