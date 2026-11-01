import { useMemo } from 'react';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { effortLabel, type EffortLevel } from '../../state/preferences';
import { ModelPicker } from '../../../ui/model-picker/ModelPicker';
import { enabledModelCount, findSelectionModel, groupProviderModels, modelEffortLevels, supportsComposerFastMode } from '../../../ui/model-picker/modelSelection';

export function ComposerModelMenu({
  providers,
  selectedModelId,
  effort,
  fastMode,
  isZh,
  disabled = false,
  title,
  onSelectModel,
  onEffortChange,
  onFastModeChange,
  onManageModels,
}: {
  readonly providers: readonly LlmProviderConfigView[];
  readonly selectedModelId: string | null;
  readonly effort: EffortLevel;
  readonly fastMode: boolean;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onSelectModel: (modelId: string) => void;
  readonly onEffortChange: (level: EffortLevel) => void | Promise<unknown>;
  readonly onFastModeChange?: (enabled: boolean) => void;
  readonly onManageModels?: () => void;
}) {
  const groups = useMemo(() => groupProviderModels(providers, isZh), [isZh, providers]);
  const selected = selectedModelId ? findSelectionModel(groups, selectedModelId) : null;
  const model = selected?.model;
  const effortLevels = modelEffortLevels(model);
  const fastAvailable = supportsComposerFastMode(model?.authMethod) && Boolean(onFastModeChange);
  const interactive = Boolean(model) && (enabledModelCount(groups) > 1 || effortLevels.length > 1 || fastAvailable);
  const label = model?.label || (isZh ? '选择模型' : 'Choose a model');
  const effortText = effortLevels.includes(effort) ? effortLabel(effort, isZh) : '';
  const tooltip = [selected?.group.label, model?.label, effortText].filter(Boolean).join(' · ') || title;
  if (!model) return null;
  if (!interactive) return <span className="token-usage-model" title={tooltip}>{label}</span>;
  return (
    <ModelPicker className="composer-cascading-menu composer-model-dropdown"
      groups={groups}
      selectedModelId={selectedModelId ?? model.id}
      effort={effort}
      fastMode={fastMode}
      isZh={isZh}
      disabled={disabled}
      label={label}
      title={tooltip}
      onSelectModel={onSelectModel}
      onEffortChange={onEffortChange}
      onFastModeChange={onFastModeChange}
      onManageModels={onManageModels}
    />
  );
}
