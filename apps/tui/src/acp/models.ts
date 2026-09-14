import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { createTuiContextSelectionControl, type TuiContextSelectionControl, type TuiModelSelectionControl } from '../tui-model-selection.ts';
import { buildModelMenuGroups, modelMenuChannelName } from '@peer-agent/protocol';
import type { SharedModelMetadata } from '@peer-agent/runtime-node';

// JSON tuples keep provider/model boundaries unambiguous, including delimiters in IDs.
export const acpModelId = (providerId: string, modelId: string): string => JSON.stringify([providerId, modelId]);

export function createAcpModelConfig(control: TuiModelSelectionControl, persist: () => void, metadata: readonly SharedModelMetadata[] = [], isZh = false, context: TuiContextSelectionControl = createTuiContextSelectionControl(control, metadata)) {
  function supportsReasoning() {
    const selected = control.getSelection();
    return metadata.some((item) => item.credentialId === selected.providerId && item.model === selected.modelId && item.supportsReasoning === true);
  }
  function getConfigOptions(): SessionConfigOption[] {
    const selected = control.getSelection();
    const entry = control.catalog.find((item) => item.providerId === selected.providerId && item.modelId === selected.modelId);
    const definition = context.getDefinition();
    const options: SessionConfigOption[] = [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: acpModelId(selected.providerId, selected.modelId),
      options: buildModelMenuGroups(control.catalog.map((entry) => {
        const source = metadata.find((item) => item.credentialId === entry.providerId && item.model === entry.modelId);
        return {
          id: acpModelId(entry.providerId, entry.modelId), groupId: entry.providerId,
          groupLabel: modelMenuChannelName(source?.displayName || 'Peer', entry.modelId, source?.authMethod, isZh), model: entry.modelId,
          modelLabel: source?.modelLabel, available: entry.available,
        };
      }), true).map((group) => ({
        group: group.id, name: group.label,
        options: group.items.map((item) => ({ value: item.id, name: item.label })),
      })),
    }];
    if (supportsReasoning() && entry && entry.supportedReasoningEfforts.length > 1) options.push({
      id: 'reasoning_effort', name: isZh ? '推理强度' : 'Reasoning effort', category: 'thought_level', type: 'select',
      currentValue: selected.reasoningEffort,
      options: entry.supportedReasoningEfforts.map((value) => ({ value, name: value })),
    });
    if (definition && context.getValue() !== undefined) options.push({
      id: 'context_window', name: isZh ? '上下文窗口' : 'Context window', type: 'select',
      currentValue: JSON.stringify(context.getValue()),
      options: definition.choices.map((choice) => ({ value: JSON.stringify(choice.value), name: choice.label })),
    });
    return options;
  }
  return {
    getConfigOptions,
    setConfigOption(configId: string, value: string): SessionConfigOption[] {
      if (configId === 'context_window') {
        const choice = context.getDefinition()?.choices.find((item) => JSON.stringify(item.value) === value);
        if (!choice) throw RequestError.invalidParams(null, 'Unsupported context value');
        context.setValue(choice.value);
        return getConfigOptions();
      }
      if (configId === 'reasoning_effort') {
        const previous = control.getSelection();
        const entry = control.catalog.find((item) => item.providerId === previous.providerId && item.modelId === previous.modelId);
        const effort = entry?.supportedReasoningEfforts.find((item) => item === value);
        if (!supportsReasoning() || !effort || !entry || entry.supportedReasoningEfforts.length < 2) throw RequestError.invalidParams(null, 'Unsupported reasoning effort');
        control.setSelection({ ...previous, reasoningEffort: effort });
        try { persist(); } catch (error) { control.setSelection(previous); throw error; }
        return getConfigOptions();
      }
      if (configId !== 'model') throw RequestError.invalidParams(null, 'Unknown configuration option');
      const target = control.catalog.find((entry) => entry.available && acpModelId(entry.providerId, entry.modelId) === value);
      if (!target) throw RequestError.invalidParams(null, 'Unknown or unavailable model');
      const previous = control.getSelection();
      control.setSelection({ providerId: target.providerId, modelId: target.modelId,
        reasoningEffort: target.supportedReasoningEfforts.includes(previous.reasoningEffort) ? previous.reasoningEffort : target.defaultReasoningEffort });
      try { persist(); } catch (error) { control.setSelection(previous); throw error; }
      return getConfigOptions();
    },
  };
}
