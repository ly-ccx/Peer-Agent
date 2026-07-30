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

export type ModelPickerStage = 'models' | 'efforts';

export interface ModelPickerViewRow {
  readonly key: string;
  readonly kind: 'section' | 'model' | 'effort';
  readonly label: string;
  readonly detail?: string;
  readonly current: boolean;
  readonly selectable: boolean;
  readonly selection?: RuntimeModelSelection;
  readonly modelRef?: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

export interface ModelPickerView {
  readonly stage: ModelPickerStage;
  readonly title: string;
  readonly subtitle?: string;
  readonly query: string;
  readonly groups: readonly string[];
  readonly activeGroup: string | null;
  readonly rows: readonly ModelPickerViewRow[];
  readonly selectableRows: readonly ModelPickerViewRow[];
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
  const efforts = input.supportedReasoningEfforts ?? ['off', 'low', 'default', 'high'];
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
  let selection: RuntimeModelSelection = (() => {
    // Prefer the requested model; clamp effort into that model's projected levels
    // instead of jumping to an unrelated catalog entry (Desktop-aligned).
    if (initialModel) {
      if (initialModel.supportedReasoningEfforts.includes(initialSelection.reasoningEffort)) {
        return initialSelection;
      }
      return {
        providerId: initialModel.providerId,
        modelId: initialModel.modelId,
        reasoningEffort: initialModel.defaultReasoningEffort,
      };
    }
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

/**
 * Resolve a conversation-persisted model binding into a valid catalog selection.
 *
 * Desktop conversation meta stores modelProviderId in three shapes (see Desktop
 * usage-stats resolveProviderRecord): the model entry uuid, the channel groupId,
 * or the legacy `groupId::model` composite (already stripped by the persistence
 * reader). The CLI catalog keys entries by groupId only, so uuid-shaped bindings
 * must map through entryId before the strict setSelection validation. Returns
 * null when nothing in the catalog can host the binding; callers keep the
 * current selection instead of throwing.
 */
export function resolvePersistedModelSelection(
  control: TuiModelSelectionControl,
  persisted: RuntimeModelSelection,
): RuntimeModelSelection | null {
  const available = control.catalog.filter((entry) => entry.available);
  const match =
    available.find((entry) =>
      entry.providerId === persisted.providerId && entry.modelId === persisted.modelId)
    // Desktop binds by the model entry uuid; the matched entry pins both the
    // groupId-keyed provider and the concrete model.
    ?? available.find((entry) => entry.entryId === persisted.providerId)
    // Binding/model drift (group binding with a foreign model snapshot): keep
    // the provider and fall back to one of its models, Desktop-aligned.
    ?? available.find((entry) => entry.providerId === persisted.providerId);
  if (!match) return null;
  return {
    providerId: match.providerId,
    modelId: match.modelId,
    reasoningEffort: match.supportedReasoningEfforts.includes(persisted.reasoningEffort)
      ? persisted.reasoningEffort
      : match.defaultReasoningEffort,
  };
}

/** Split "model · provider" labels back into provider/model parts for grouping. */
export function splitModelDisplayName(displayName: string, fallbackModelId: string): {
  readonly providerName: string;
  readonly modelName: string;
} {
  const separator = ' · ';
  const index = displayName.lastIndexOf(separator);
  if (index <= 0) {
    return {
      providerName: 'Models',
      modelName: displayName || fallbackModelId,
    };
  }
  return {
    modelName: displayName.slice(0, index).trim() || fallbackModelId,
    providerName: displayName.slice(index + separator.length).trim() || 'Models',
  };
}

export function availableCatalogModels(
  control: TuiModelSelectionControl,
): readonly RuntimeModelCatalogEntry[] {
  return control.catalog.filter((entry) => entry.available);
}

export function visibleCatalogModels(
  control: TuiModelSelectionControl,
): readonly RuntimeModelCatalogEntry[] {
  // CLI shows the full Desktop catalog, including unsupported auth methods.
  return control.catalog;
}

export function modelPickerGroups(control: TuiModelSelectionControl): readonly string[] {
  const groups: string[] = [];
  const seen = new Set<string>();
  for (const entry of visibleCatalogModels(control)) {
    const { providerName } = splitModelDisplayName(entry.displayName, entry.modelId);
    if (seen.has(providerName)) continue;
    seen.add(providerName);
    groups.push(providerName);
  }
  return groups;
}

export function modelPickerGroupCounts(
  control: TuiModelSelectionControl,
): ReadonlyMap<string, { readonly total: number; readonly available: number }> {
  const counts = new Map<string, { total: number; available: number }>();
  for (const entry of visibleCatalogModels(control)) {
    const { providerName } = splitModelDisplayName(entry.displayName, entry.modelId);
    const current = counts.get(providerName) ?? { total: 0, available: 0 };
    current.total += 1;
    if (entry.available) current.available += 1;
    counts.set(providerName, current);
  }
  return counts;
}

function matchesQuery(entry: RuntimeModelCatalogEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const { providerName, modelName } = splitModelDisplayName(entry.displayName, entry.modelId);
  return [
    entry.displayName,
    entry.modelId,
    entry.providerId,
    providerName,
    modelName,
  ].some((value) => value.toLowerCase().includes(normalized));
}

export function modelPickerItems(control: TuiModelSelectionControl): readonly RuntimeModelSelection[] {
  // Backward-compatible flat list used by older tests; UI now prefers buildModelPickerView().
  return availableCatalogModels(control).flatMap((model) => model.supportedReasoningEfforts.map((reasoningEffort) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningEffort,
  })));
}

export function buildModelPickerView(input: {
  readonly control: TuiModelSelectionControl;
  readonly current: RuntimeModelSelection;
  readonly query?: string;
  readonly stage?: ModelPickerStage;
  readonly activeGroup?: string | null;
  readonly pendingModel?: {
    readonly providerId: string;
    readonly modelId: string;
  } | null;
}): ModelPickerView {
  const stage = input.stage ?? 'models';
  const query = input.query ?? '';
  const groups = modelPickerGroups(input.control);
  const activeGroup = input.activeGroup && groups.includes(input.activeGroup)
    ? input.activeGroup
    : (groups[0] ?? null);

  if (stage === 'efforts' && input.pendingModel) {
    const model = availableCatalogModels(input.control).find((entry) =>
      entry.providerId === input.pendingModel?.providerId
      && entry.modelId === input.pendingModel?.modelId
    );
    if (model) {
      const { providerName, modelName } = splitModelDisplayName(model.displayName, model.modelId);
      const rows: ModelPickerViewRow[] = model.supportedReasoningEfforts.map((reasoningEffort) => ({
        key: `${model.providerId}:${model.modelId}:${reasoningEffort}`,
        kind: 'effort',
        label: reasoningEffort,
        detail: reasoningEffort === model.defaultReasoningEffort ? 'default' : undefined,
        current: input.current.providerId === model.providerId
          && input.current.modelId === model.modelId
          && input.current.reasoningEffort === reasoningEffort,
        selectable: true,
        selection: {
          providerId: model.providerId,
          modelId: model.modelId,
          reasoningEffort,
        },
      }));
      return {
        stage,
        title: 'Reasoning effort',
        subtitle: `${modelName} · ${providerName}`,
        query,
        groups,
        activeGroup: providerName,
        rows,
        selectableRows: rows,
      };
    }
  }

  const filtered = visibleCatalogModels(input.control).filter((entry) => matchesQuery(entry, query));
  const scoped = activeGroup
    ? filtered.filter((entry) => splitModelDisplayName(entry.displayName, entry.modelId).providerName === activeGroup)
    : filtered;

  // When searching, show cross-group matches with section headers.
  const source = query.trim() ? filtered : scoped;
  const rows: ModelPickerViewRow[] = [];
  let lastGroup: string | null = null;
  for (const entry of source) {
    const { providerName, modelName } = splitModelDisplayName(entry.displayName, entry.modelId);
    if (query.trim() && providerName !== lastGroup) {
      rows.push({
        key: `section:${providerName}`,
        kind: 'section',
        label: providerName,
        current: false,
        selectable: false,
      });
      lastGroup = providerName;
    }
    const multiEffort = entry.supportedReasoningEfforts.length > 1;
    const detailParts: string[] = [];
    if (!entry.available) {
      detailParts.push(entry.unavailableReason ?? 'unavailable');
    } else if (multiEffort) {
      detailParts.push(`${entry.supportedReasoningEfforts.length} efforts · ${entry.defaultReasoningEffort}`);
    } else {
      detailParts.push(entry.defaultReasoningEffort);
    }
    rows.push({
      key: `${entry.providerId}:${entry.modelId}`,
      kind: 'model',
      label: modelName,
      detail: detailParts.join(' · '),
      current: input.current.providerId === entry.providerId && input.current.modelId === entry.modelId,
      selectable: entry.available,
      modelRef: entry.available ? {
        providerId: entry.providerId,
        modelId: entry.modelId,
      } : undefined,
      selection: entry.available ? {
        providerId: entry.providerId,
        modelId: entry.modelId,
        reasoningEffort: entry.defaultReasoningEffort,
      } : undefined,
    });
  }

  const selectableRows = rows.filter((row) => row.selectable);
  const groupCounts = modelPickerGroupCounts(input.control);
  const activeCount = activeGroup ? groupCounts.get(activeGroup) : undefined;
  return {
    stage: 'models',
    title: 'Model',
    subtitle: query.trim()
      ? `${rows.filter((row) => row.kind === 'model').length} matches · ${selectableRows.length} runnable`
      : (activeCount
        ? `${activeCount.available}/${activeCount.total} runnable`
        : undefined),
    query,
    groups,
    activeGroup,
    rows,
    selectableRows,
  };
}

export function modelSelectionLabel(
  control: TuiModelSelectionControl,
  selection: RuntimeModelSelection,
): string {
  const model = control.catalog.find((entry) =>
    entry.providerId === selection.providerId && entry.modelId === selection.modelId);
  if (!model) return `${selection.modelId} · ${selection.reasoningEffort}`;
  const { providerName, modelName } = splitModelDisplayName(model.displayName, model.modelId);
  return `${modelName} · ${providerName} · ${selection.reasoningEffort}`;
}

/** Session topbar model chip: `PROVIDER / MODEL` (design-aligned, no reasoning suffix). */
export function sessionTopbarModelLabel(
  control: TuiModelSelectionControl | null | undefined,
  selection: RuntimeModelSelection | null | undefined,
  fallbackModelLabel?: string,
): string {
  if (selection && control) {
    const model = control.catalog.find((entry) =>
      entry.providerId === selection.providerId && entry.modelId === selection.modelId);
    if (model) {
      const { providerName, modelName } = splitModelDisplayName(model.displayName, model.modelId);
      const provider = providerName === 'Models' ? selection.providerId : providerName;
      return `${normalizeTopbarToken(provider)} / ${normalizeTopbarToken(modelName)}`;
    }
    return `${normalizeTopbarToken(selection.providerId)} / ${normalizeTopbarToken(selection.modelId)}`;
  }

  const fallback = (fallbackModelLabel ?? '').trim();
  if (!fallback) return 'MODEL';
  if (fallback.includes(' / ')) return fallback.toUpperCase();
  return normalizeTopbarToken(fallback);
}

function normalizeTopbarToken(value: string): string {
  return value.trim().replace(/\s+/g, '-').toUpperCase();
}

export function indexOfCurrentSelectableRow(
  view: ModelPickerView,
  current: RuntimeModelSelection,
): number {
  if (view.stage === 'efforts') {
    const index = view.selectableRows.findIndex((row) =>
      row.selection?.providerId === current.providerId
      && row.selection?.modelId === current.modelId
      && row.selection?.reasoningEffort === current.reasoningEffort
    );
    return index >= 0 ? index : 0;
  }
  const index = view.selectableRows.findIndex((row) =>
    row.modelRef?.providerId === current.providerId
    && row.modelRef?.modelId === current.modelId
  );
  return index >= 0 ? index : 0;
}

export function cycleModelPickerGroup(
  groups: readonly string[],
  activeGroup: string | null,
  delta: number,
): string | null {
  if (groups.length === 0) return null;
  const currentIndex = Math.max(0, groups.findIndex((group) => group === activeGroup));
  const nextIndex = (currentIndex + delta + groups.length) % groups.length;
  return groups[nextIndex] ?? null;
}


export function formatModelPickerGroupLabel(
  group: string,
  counts: ReadonlyMap<string, { readonly total: number; readonly available: number }>,
): string {
  const count = counts.get(group);
  if (!count) return group;
  return `${group} (${count.available}/${count.total})`;
}
