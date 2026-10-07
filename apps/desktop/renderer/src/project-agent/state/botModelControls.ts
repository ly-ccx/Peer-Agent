import { buildModelMenuGroups, modelMenuChannelName, type BotRoleModelView, type ModelReasoningEffort, type ModelRole, type ModelRoutingMenuOption, type ProjectModelPolicy } from '@peer-agent/protocol';

/** Display a committed fixed choice while the full main projection catches up. */
export function botConfiguredModelSelection(policy: ProjectModelPolicy | null | undefined, role: ModelRole,
  models: readonly ModelRoutingMenuOption[], view: BotRoleModelView | undefined) {
  const setting = policy?.overrides?.[role];
  if (setting?.mode !== 'fixed' || !view?.eligibleModelIds.includes(setting.modelProviderId)) return undefined;
  const model = models.find(item => item.id === setting.modelProviderId && item.available === true);
  if (!model) return undefined;
  const effort = setting.reasoningEffort ?? model.defaultReasoningEffort;
  if (effort && !model.reasoningEffortLevels?.includes(effort)) return undefined;
  return { modelProviderId: model.id, reasoningEffort: effort };
}

export function botModelMenuGroups(models: readonly ModelRoutingMenuOption[], view: BotRoleModelView | undefined, isZh: boolean) {
  return buildModelMenuGroups(models.map(model => ({ id: model.id, groupId: model.groupId,
    groupLabel: modelMenuChannelName(model.providerName, model.model, model.authMethod, isZh),
    model: model.model, modelLabel: model.label,
    available: model.available === true && view?.eligibleModelIds.includes(model.id) === true,
  })));
}

/** One atomic role patch, retaining the other roles and scope. Changing effort pins the resolved model. */
export function botFixedModelPolicy(policy: ProjectModelPolicy | null | undefined, role: ModelRole,
  model: ModelRoutingMenuOption, currentEffort?: string): ProjectModelPolicy {
  const levels = model.reasoningEffortLevels ?? [];
  const effort = currentEffort && levels.includes(currentEffort as ModelReasoningEffort)
    ? currentEffort as ModelReasoningEffort : model.defaultReasoningEffort;
  return { ...policy, overrides: { ...policy?.overrides, [role]: { mode: 'fixed', modelProviderId: model.id,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  } } };
}

export function botInheritModelPolicy(policy: ProjectModelPolicy | null | undefined, role: ModelRole): ProjectModelPolicy {
  const overrides = { ...policy?.overrides };
  delete overrides[role];
  return { ...policy, overrides };
}
