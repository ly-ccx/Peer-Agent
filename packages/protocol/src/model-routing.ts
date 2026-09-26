/**
 * Role and tier model routing. Resolution is pure; hosts apply the result.
 * Order and filters follow ADR 83. An empty candidate set is an error, not a silent downgrade.
 */

export type ModelTier = 'strong' | 'fast' | 'economy' | 'vision';

export type ModelRole =
  | 'project_agent'
  | 'session_worker'
  | 'explorer'
  | 'verifier'
  | 'visual_verifier'
  | 'memory_curator'
  | 'objective_probe'
  | 'compactor';

export type RoleSetting =
  | { readonly mode: 'tier'; readonly tier: ModelTier }
  | { readonly mode: 'fixed'; readonly modelProviderId: string }
  | { readonly mode: 'auto'; readonly pool: readonly string[] };

export interface ModelTierBinding {
  readonly primary: string;
  readonly fallbacks?: readonly string[];
}

export interface ModelRoutingSettings {
  readonly tiers: Partial<Record<ModelTier, ModelTierBinding>>;
  readonly roles: Partial<Record<ModelRole, RoleSetting>>;
  readonly verifierPreferDifferentFamily: boolean;
  readonly dailySpendCapUsd?: number;
}

export interface ProjectModelScope {
  /** Allow-list. A project may only tighten the global set. */
  readonly modelProviderIds?: readonly string[];
  readonly families?: readonly string[];
  readonly localOnly?: boolean;
}

export interface ProjectModelPolicy {
  readonly scope?: ProjectModelScope;
  readonly overrides?: Partial<Record<ModelRole, RoleSetting>>;
}

export type ModelSelectionSource =
  | 'this_request'
  | 'task'
  | 'objective'
  | 'project'
  | 'global'
  | 'auto';

export interface RuntimeModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelProviderId: string;
  readonly reasoningEffort?: string;
  readonly family: string;
}

export interface ModelSelectionSnapshot {
  readonly worker: RuntimeModelSelection;
  readonly explorer: RuntimeModelSelection;
  readonly verifier: RuntimeModelSelection & { readonly sameFamilyAsWorker: boolean };
  readonly visualVerifier?: RuntimeModelSelection;
  readonly source: Readonly<Record<string, ModelSelectionSource>>;
  readonly autoReason?: string;
  readonly resolvedAt: string;
}

export interface CatalogModel {
  readonly modelProviderId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly family: string;
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly structured?: boolean;
  readonly contextTokens?: number;
  readonly local?: boolean;
  readonly reasoningEffort?: string;
}

export type ModelResolution =
  | {
      readonly ok: true;
      readonly selection: RuntimeModelSelection;
      readonly source: ModelSelectionSource;
      readonly sameFamilyAsWorker?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'capability' | 'scope' | 'auto_pool' | 'empty';
      readonly missing: string;
    };

export interface RoleModelRequest {
  readonly role: ModelRole;
  readonly catalog: readonly CatalogModel[];
  readonly routing: ModelRoutingSettings;
  readonly projectPolicy?: ProjectModelPolicy | null;
  readonly taskOverride?: RoleSetting | null;
  readonly requestPreference?: { readonly modelProviderId: string; readonly reason?: string } | null;
  readonly workerModel?: { readonly family?: string; readonly providerId?: string; readonly modelProviderId?: string } | null;
  readonly taskRequiresVision?: boolean;
  readonly requiredContextTokens?: number;
}

const EXPLORER_MIN_CONTEXT = 8_000;

function roleNeeds(input: RoleModelRequest): { tools: boolean; vision: boolean; structured: boolean; minContext: number } {
  const context = input.requiredContextTokens ?? 0;
  switch (input.role) {
    case 'project_agent':
      return { tools: true, vision: false, structured: false, minContext: 0 };
    case 'session_worker':
      return { tools: true, vision: input.taskRequiresVision === true, structured: false, minContext: 0 };
    case 'explorer':
      return { tools: true, vision: false, structured: false, minContext: Math.max(context, EXPLORER_MIN_CONTEXT) };
    case 'verifier':
      return { tools: true, vision: false, structured: false, minContext: 0 };
    case 'visual_verifier':
      return { tools: false, vision: true, structured: false, minContext: 0 };
    case 'memory_curator':
      return { tools: false, vision: false, structured: true, minContext: 0 };
    case 'objective_probe':
      return { tools: true, vision: false, structured: false, minContext: 0 };
    case 'compactor':
      return { tools: false, vision: false, structured: false, minContext: Math.max(context, 1) };
    default:
      return { tools: false, vision: false, structured: false, minContext: 0 };
  }
}

function meetsCapability(model: CatalogModel, needs: ReturnType<typeof roleNeeds>): boolean {
  if (needs.tools && model.tools !== true) return false;
  if (needs.vision && model.vision !== true) return false;
  if (needs.structured && model.structured !== true) return false;
  if (needs.minContext > 0 && (model.contextTokens ?? 0) < needs.minContext) return false;
  return true;
}

function inScope(model: CatalogModel, policy: ProjectModelPolicy | null | undefined): boolean {
  const scope = policy?.scope;
  if (!scope) return true;
  if (scope.modelProviderIds && scope.modelProviderIds.length > 0 && !scope.modelProviderIds.includes(model.modelProviderId)) {
    return false;
  }
  if (scope.families && scope.families.length > 0 && !scope.families.includes(model.family)) return false;
  if (scope.localOnly === true && model.local !== true) return false;
  return true;
}

function missingText(input: RoleModelRequest, reason: Extract<ModelResolution, { ok: false }>['reason']): string {
  if (reason === 'auto_pool') return '所选模型不在自动池内';
  const localOnly = input.projectPolicy?.scope?.localOnly === true;
  if (input.role === 'visual_verifier') {
    if (localOnly) return '本项目只允许本地模型，但没有能看图的本地模型';
    if (reason === 'scope') return '本项目的模型范围里没有能看图的模型';
    if (reason === 'empty') return '没有可用的模型';
    return '没有能看图的模型';
  }
  if (reason === 'scope') return '本项目的模型范围里没有满足该角色要求的模型';
  if (reason === 'capability') return '没有满足该角色能力要求的模型';
  return '没有可用的模型';
}

function expandSetting(setting: RoleSetting, routing: ModelRoutingSettings): readonly string[] {
  if (setting.mode === 'fixed') return setting.modelProviderId ? [setting.modelProviderId] : [];
  if (setting.mode === 'auto') return setting.pool.filter((id) => typeof id === 'string' && id.trim());
  const binding = routing.tiers[setting.tier];
  if (!binding) return [];
  return [binding.primary, ...(binding.fallbacks ?? [])].filter((id) => typeof id === 'string' && id.trim());
}

function sameFamily(
  model: CatalogModel,
  worker: RoleModelRequest['workerModel'],
): boolean {
  if (!worker) return false;
  if (worker.family) return model.family === worker.family;
  if (worker.providerId) return model.providerId === worker.providerId;
  if (worker.modelProviderId) return model.modelProviderId === worker.modelProviderId;
  return false;
}

function orderCandidates(
  models: readonly CatalogModel[],
  input: RoleModelRequest,
): CatalogModel[] {
  if (input.role !== 'verifier' || input.routing.verifierPreferDifferentFamily !== true) return [...models];
  const different = models.filter((model) => !sameFamily(model, input.workerModel));
  const same = models.filter((model) => sameFamily(model, input.workerModel));
  return [...different, ...same];
}

function toSelection(model: CatalogModel): RuntimeModelSelection {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    modelProviderId: model.modelProviderId,
    family: model.family,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  };
}

interface Layer {
  readonly source: ModelSelectionSource;
  readonly setting: RoleSetting;
  readonly requestedId?: string;
}

/** The auto pool that constrains a this-request pick. A fixed or tier override above it does not. */
function constrainingAutoPool(input: RoleModelRequest): readonly string[] | null {
  if (input.taskOverride?.mode === 'fixed' || input.taskOverride?.mode === 'tier') return null;
  if (input.taskOverride?.mode === 'auto') return input.taskOverride.pool;
  const projectOverride = input.projectPolicy?.overrides?.[input.role];
  if (projectOverride?.mode === 'fixed' || projectOverride?.mode === 'tier') return null;
  if (projectOverride?.mode === 'auto') return projectOverride.pool;
  const globalSetting = input.routing.roles[input.role];
  if (globalSetting?.mode === 'auto') return globalSetting.pool;
  return null;
}

function layersOf(input: RoleModelRequest): Layer[] {
  const layers: Layer[] = [];
  const requestedId = input.requestPreference?.modelProviderId;
  const autoPool = constrainingAutoPool(input);
  if (requestedId && autoPool) {
    layers.push({
      source: 'auto',
      setting: { mode: 'auto', pool: autoPool },
      requestedId,
    });
  } else if (requestedId) {
    layers.push({
      source: 'this_request',
      setting: { mode: 'fixed', modelProviderId: requestedId },
      requestedId,
    });
  }
  if (!requestedId) {
    if (input.taskOverride) layers.push({ source: 'task', setting: input.taskOverride });
    const projectOverride = input.projectPolicy?.overrides?.[input.role];
    if (projectOverride) layers.push({ source: 'project', setting: projectOverride });
    const globalSetting = input.routing.roles[input.role];
    if (globalSetting) layers.push({ source: 'global', setting: globalSetting });
  }
  return layers;
}

function fail(input: RoleModelRequest, reason: 'capability' | 'scope' | 'auto_pool' | 'empty'): ModelResolution {
  return { ok: false, reason, missing: missingText(input, reason) };
}

/**
 * Pick one model for a role. The first configured layer wins.
 * Capability and project scope filter that layer; they do not silently fall through.
 */
export function resolveRoleModel(input: RoleModelRequest): ModelResolution {
  const catalog = new Map(input.catalog.map((model) => [model.modelProviderId, model]));
  const needs = roleNeeds(input);
  const layers = layersOf(input);
  if (layers.length === 0) return fail(input, 'empty');

  for (const layer of layers) {
    if (layer.setting.mode === 'auto' && layer.requestedId && !layer.setting.pool.includes(layer.requestedId)) {
      return fail(input, 'auto_pool');
    }
    const ids = layer.setting.mode === 'auto' && layer.requestedId
      ? [layer.requestedId]
      : expandSetting(layer.setting, input.routing);
    if (ids.length === 0) continue;
    const models = ids
      .map((id) => catalog.get(id))
      .filter((model): model is CatalogModel => Boolean(model));
    const eligible: CatalogModel[] = [];
    let layerScopeReject = false;
    let layerCapabilityReject = false;
    for (const model of models) {
      if (!inScope(model, input.projectPolicy)) {
        layerScopeReject = true;
        continue;
      }
      if (!meetsCapability(model, needs)) {
        layerCapabilityReject = true;
        continue;
      }
      eligible.push(model);
    }
    if (eligible.length === 0) {
      if (layerScopeReject && !layerCapabilityReject) return fail(input, 'scope');
      if (layerCapabilityReject) return fail(input, 'capability');
      return fail(input, 'empty');
    }
    const ordered = orderCandidates(eligible, input);
    const chosen = ordered[0];
    if (!chosen) return fail(input, 'empty');
    const source: ModelSelectionSource = layer.setting.mode === 'auto' ? 'auto' : layer.source;
    return {
      ok: true,
      selection: toSelection(chosen),
      source,
      ...(input.role === 'verifier'
        ? { sameFamilyAsWorker: sameFamily(chosen, input.workerModel) }
        : {}),
    };
  }

  return fail(input, 'empty');
}
