import type {
  ModelReasoningEffort,
  RuntimeModelCatalogEntry,
  RuntimeModelSelection,
} from '@peer-agent/runtime-node';

export interface TuiModelSelectionControl {
  readonly catalog: readonly RuntimeModelCatalogEntry[];
  getSelection(): RuntimeModelSelection;
  setSelection(selection: RuntimeModelSelection): void;
}

export function createTuiModelSelectionControl(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly supportedReasoningEfforts?: readonly ModelReasoningEffort[];
  readonly catalog?: readonly RuntimeModelCatalogEntry[];
}): TuiModelSelectionControl {
  const efforts = input.supportedReasoningEfforts ?? ['default', 'low', 'high'];
  const catalog: readonly RuntimeModelCatalogEntry[] = Object.freeze(input.catalog ?? [{
    providerId: input.providerId,
    modelId: input.modelId,
    displayName: input.displayName,
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    supportsTools: true,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: input.reasoningEffort ?? 'default',
    available: true,
  }]);
  const initialSelection: RuntimeModelSelection = {
    providerId: input.providerId,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort ?? 'default',
  };
  const initialModel = catalog.find((entry) =>
    entry.providerId === initialSelection.providerId
    && entry.modelId === initialSelection.modelId
    && entry.available
  );
  let selection: RuntimeModelSelection = initialModel
    && initialModel.supportedReasoningEfforts.includes(initialSelection.reasoningEffort)
    ? initialSelection
    : (() => {
      const fallback = catalog.find((entry) => entry.available);
      if (!fallback) return initialSelection;
      return {
        providerId: fallback.providerId,
        modelId: fallback.modelId,
        reasoningEffort: fallback.defaultReasoningEffort,
      };
    })();
  return {
    catalog,
    getSelection: () => selection,
    setSelection(next) {
      const model = catalog.find((entry) => entry.providerId === next.providerId && entry.modelId === next.modelId);
      if (!model?.available || !model.supportedReasoningEfforts.includes(next.reasoningEffort)) {
        throw new Error('Selected model or reasoning effort is unavailable.');
      }
      selection = next;
    },
  };
}

export function modelPickerItems(control: TuiModelSelectionControl): readonly RuntimeModelSelection[] {
  return control.catalog.flatMap((model) => model.available
    ? model.supportedReasoningEfforts.map((reasoningEffort) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        reasoningEffort,
      }))
    : []);
}

export function modelSelectionLabel(
  control: TuiModelSelectionControl,
  selection: RuntimeModelSelection,
): string {
  const model = control.catalog.find((entry) =>
    entry.providerId === selection.providerId && entry.modelId === selection.modelId);
  return `${model?.displayName ?? selection.modelId} · ${selection.reasoningEffort}`;
}
