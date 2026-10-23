import { modelMenuChannelName, type LlmProviderConfigView } from '@peer-agent/protocol';
import {
  hasTunableEffortLevels,
  normalizeEffortLevels,
  resolveModelSwitchEffort,
  type EffortLevel,
} from '../../state/preferences';

/** ChatGPT / Grok subscription login may request the priority service tier. */
export function supportsComposerFastMode(authMethod: string | null | undefined): boolean {
  return authMethod === 'oauth_chatgpt' || authMethod === 'oauth_grok';
}

export interface SelectionModel {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly supportsVision: boolean;
  readonly authMethod: string;
  readonly supportsReasoning: boolean;
  readonly reasoningEffortLevels?: readonly string[];
  readonly reasoningDefaultEffort?: string;
}

export interface SelectionProviderGroup {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly models: readonly SelectionModel[];
}

export interface SelectionMenuItem {
  readonly value: string;
  readonly label: string;
  readonly group?: string;
  readonly groupId?: string;
  readonly disabled?: boolean;
  readonly supportsVision?: boolean;
  readonly authMethod?: string;
  readonly supportsReasoning?: boolean;
  readonly reasoningEffortLevels?: readonly string[];
  readonly reasoningDefaultEffort?: string;
}

function finishGroups(
  groups: Map<string, { id: string; label: string; models: SelectionModel[] }>,
): readonly SelectionProviderGroup[] {
  return [...groups.values()].map((group) => ({
    ...group,
    disabled: group.models.length === 0 || group.models.every((model) => model.disabled),
  }));
}

/** Fold flat provider records into the provider → model list the picker shows. */
export function groupProviderModels(
  providers: readonly LlmProviderConfigView[],
  isZh: boolean,
): readonly SelectionProviderGroup[] {
  const groups = new Map<string, { id: string; label: string; models: SelectionModel[] }>();
  for (const provider of providers) {
    const id = provider.groupId || provider.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: modelMenuChannelName(provider.name, provider.model, provider.authMethod, isZh),
        models: [],
      };
      groups.set(id, group);
    }
    group.models.push({
      id: provider.id,
      label: provider.modelLabel || provider.model,
      disabled: provider.apiKeyConfigured !== true,
      supportsVision: provider.supportsVision === true,
      authMethod: provider.authMethod,
      supportsReasoning: provider.supportsReasoning === true,
      reasoningEffortLevels: provider.reasoningEffortLevels,
      reasoningDefaultEffort: provider.reasoningDefaultEffort,
    });
  }
  return finishGroups(groups);
}

/** Same grouping for the quick-chat popover payload. */
export function selectionGroupsFromItems(
  items: readonly SelectionMenuItem[],
): readonly SelectionProviderGroup[] {
  const groups = new Map<string, { id: string; label: string; models: SelectionModel[] }>();
  for (const item of items) {
    const id = item.groupId || item.group || item.value;
    let group = groups.get(id);
    if (!group) {
      group = { id, label: item.group || item.label, models: [] };
      groups.set(id, group);
    }
    group.models.push({
      id: item.value,
      label: item.label,
      disabled: item.disabled === true,
      supportsVision: item.supportsVision === true,
      authMethod: item.authMethod ?? '',
      supportsReasoning: item.supportsReasoning === true,
      reasoningEffortLevels: item.reasoningEffortLevels,
      reasoningDefaultEffort: item.reasoningDefaultEffort,
    });
  }
  return finishGroups(groups);
}

export function findSelectionModel(
  groups: readonly SelectionProviderGroup[],
  modelId: string,
): { readonly group: SelectionProviderGroup; readonly model: SelectionModel } | null {
  for (const group of groups) {
    const model = group.models.find((item) => item.id === modelId);
    if (model) return { group, model };
  }
  return null;
}

/** Slider stops. A model that cannot tune reasoning contributes none. */
export function modelEffortLevels(model: SelectionModel | undefined): readonly EffortLevel[] {
  if (model?.supportsReasoning !== true) return [];
  const levels = normalizeEffortLevels(model.reasoningEffortLevels);
  return hasTunableEffortLevels(levels) && levels.length > 1 ? levels : [];
}

/** Match the composer model switch: keep the level, or the nearest declared one. */
export function effortAfterModelSwitch(
  current: EffortLevel,
  model: {
    readonly supportsReasoning?: boolean;
    readonly reasoningEffortLevels?: readonly string[];
    readonly reasoningDefaultEffort?: string;
  } | undefined,
): EffortLevel {
  if (model?.supportsReasoning !== true) return current;
  return resolveModelSwitchEffort(
    current,
    normalizeEffortLevels(model.reasoningEffortLevels),
    model.reasoningDefaultEffort,
  );
}

export function enabledModelCount(groups: readonly SelectionProviderGroup[]): number {
  return groups.reduce((count, group) => count + group.models.filter((model) => !model.disabled).length, 0);
}
