/**
 * Desktop and TUI share this adapter. It turns the local provider catalog
 * into resolveRoleModel input and applies the daily spend cap.
 * Defaults are computed on read. This module does not persist settings.
 */

import { resolveRoleModel } from '@peer-agent/protocol';

const ROLE_TIERS = {
  project_agent: 'fast',
  session_worker: 'strong',
  explorer: 'economy',
  verifier: 'strong',
  visual_verifier: 'vision',
  memory_curator: 'economy',
  objective_probe: 'economy',
  compactor: 'economy',
};

const ESSENTIAL_ROLES = new Set(['project_agent', 'session_worker']);
const TIERS = ['strong', 'fast', 'economy', 'vision'];
const UNKNOWN_CONTEXT_TOKENS = 128_000;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function providerFamily(provider) {
  const type = text(provider?.providerType) || text(provider?.provider);
  if (type) return type.toLowerCase();
  return text(provider?.groupId) || text(provider?.id) || 'unknown';
}

export function isRoutableProvider(provider) {
  return Boolean(
    provider
    && provider.enabled !== false
    && provider.apiKeyConfigured
    && text(provider.id),
  );
}

function contextTokens(provider) {
  const value = Number(provider?.contextWindow);
  return Number.isFinite(value) && value > 0 ? value : UNKNOWN_CONTEXT_TOKENS;
}

export function catalogFromProviders(providers = []) {
  return providers.filter(isRoutableProvider).map((provider) => {
    const modelProviderId = text(provider.id);
    return {
      modelProviderId,
      providerId: text(provider.groupId) || modelProviderId,
      modelId: text(provider.model) || modelProviderId,
      family: providerFamily(provider),
      tools: provider.supportsTools !== false && provider.capabilities?.toolUse !== false,
      vision: provider.supportsVision === true,
      structured: provider.supportsStructured !== false,
      contextTokens: contextTokens(provider),
      local: provider.local === true,
      ...(text(provider.reasoningEffort) ? { reasoningEffort: text(provider.reasoningEffort) } : {}),
    };
  });
}

function tierBinding(providerId) {
  return providerId ? { primary: providerId, fallbacks: [] } : null;
}

export function buildDefaultModelRouting(providers = []) {
  const usable = providers.filter(isRoutableProvider);
  const primary = usable.find((provider) => provider.isDefault) || usable[0] || null;
  const vision = usable.find((provider) => provider.supportsVision === true) || null;
  const primaryId = text(primary?.id);
  const tiers = {};
  if (primaryId) {
    tiers.strong = tierBinding(primaryId);
    tiers.fast = tierBinding(primaryId);
    tiers.economy = tierBinding(primaryId);
  }
  const visionId = text(vision?.id);
  if (visionId) tiers.vision = tierBinding(visionId);
  const roles = {};
  for (const [role, tier] of Object.entries(ROLE_TIERS)) {
    roles[role] = { mode: 'tier', tier };
  }
  return {
    tiers,
    roles,
    verifierPreferDifferentFamily: true,
  };
}

function cleanTier(value) {
  if (!isRecord(value) || !text(value.primary)) return null;
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks.map(text).filter(Boolean)
    : [];
  return { primary: text(value.primary), ...(fallbacks.length ? { fallbacks } : { fallbacks: [] }) };
}

function cleanRole(value) {
  if (!isRecord(value)) return null;
  if (value.mode === 'tier' && TIERS.includes(value.tier)) return { mode: 'tier', tier: value.tier };
  if (value.mode === 'fixed' && text(value.modelProviderId)) {
    return { mode: 'fixed', modelProviderId: text(value.modelProviderId) };
  }
  if (value.mode === 'auto' && Array.isArray(value.pool)) {
    return { mode: 'auto', pool: value.pool.map(text).filter(Boolean) };
  }
  return null;
}

function cleanRoleCaps(value) {
  if (!isRecord(value)) return null;
  const caps = {};
  for (const [role, amount] of Object.entries(value)) {
    const number = Number(amount);
    if (ROLE_TIERS[role] && Number.isFinite(number) && number >= 0) caps[role] = number;
  }
  return Object.keys(caps).length ? caps : null;
}

/** Fill anything the stored settings omit. Reading does not write the defaults back. */
export function resolveStoredModelRouting(stored, providers = []) {
  const defaults = buildDefaultModelRouting(providers);
  const source = isRecord(stored) ? stored : {};
  const tiers = { ...defaults.tiers };
  if (isRecord(source.tiers)) {
    for (const tier of TIERS) {
      const cleaned = cleanTier(source.tiers[tier]);
      if (cleaned) tiers[tier] = cleaned;
    }
  }
  const roles = { ...defaults.roles };
  if (isRecord(source.roles)) {
    for (const role of Object.keys(ROLE_TIERS)) {
      const cleaned = cleanRole(source.roles[role]);
      if (cleaned) roles[role] = cleaned;
    }
  }
  const cap = Number(source.dailySpendCapUsd);
  const roleSpendCaps = cleanRoleCaps(source.roleSpendCaps);
  return {
    tiers,
    roles,
    verifierPreferDifferentFamily: source.verifierPreferDifferentFamily !== false,
    ...(Number.isFinite(cap) && cap >= 0 ? { dailySpendCapUsd: cap } : {}),
    ...(roleSpendCaps ? { roleSpendCaps } : {}),
  };
}

export function evaluateRoleSpendCap({ role, spentUsd, capUsd } = {}) {
  const cap = Number(capUsd);
  const spent = Number(spentUsd);
  if (!Number.isFinite(cap) || cap < 0 || !Number.isFinite(spent)) {
    return { exceeded: false, blocks: false };
  }
  const exceeded = spent >= cap;
  return {
    exceeded,
    blocks: exceeded && !ESSENTIAL_ROLES.has(role),
  };
}

function capFor(routing, role) {
  const perRole = Number(routing?.roleSpendCaps?.[role]);
  if (Number.isFinite(perRole) && perRole >= 0) return perRole;
  const shared = Number(routing?.dailySpendCapUsd);
  if (Number.isFinite(shared) && shared >= 0) return shared;
  return null;
}

function providerById(providers, modelProviderId) {
  const id = text(modelProviderId);
  if (!id) return null;
  return providers.find((provider) => text(provider?.id) === id) || null;
}

function winningSetting(input, routing, source) {
  if (source === 'this_request' && text(input.requestPreference?.modelProviderId)) {
    return { mode: 'fixed', modelProviderId: text(input.requestPreference.modelProviderId) };
  }
  if (source === 'task' && input.taskOverride) return input.taskOverride;
  if (source === 'project') return input.projectPolicy?.overrides?.[input.role] || null;
  if (source === 'auto') {
    if (input.taskOverride?.mode === 'auto') return input.taskOverride;
    const project = input.projectPolicy?.overrides?.[input.role];
    if (project?.mode === 'auto') return project;
  }
  return routing.roles?.[input.role] || null;
}

function idsFromSetting(setting, routing) {
  if (!setting) return [];
  if (setting.mode === 'fixed') return text(setting.modelProviderId) ? [text(setting.modelProviderId)] : [];
  if (setting.mode === 'auto') return (setting.pool || []).map(text).filter(Boolean);
  const binding = routing.tiers?.[setting.tier];
  if (!binding || !text(binding.primary)) return [];
  return [text(binding.primary), ...(binding.fallbacks || []).map(text).filter(Boolean)];
}

function eligibleIds(ids, input, routing, workerModel) {
  const scopeOnly = input.projectPolicy?.scope ? { scope: input.projectPolicy.scope } : null;
  const eligible = [];
  for (const id of ids) {
    const trial = resolveRoleModel({
      role: input.role,
      catalog: input.catalog,
      routing: {
        tiers: routing.tiers,
        roles: { [input.role]: { mode: 'fixed', modelProviderId: id } },
        verifierPreferDifferentFamily: false,
      },
      projectPolicy: scopeOnly,
      workerModel,
      taskRequiresVision: input.taskRequiresVision,
      requiredContextTokens: input.requiredContextTokens,
    });
    if (trial.ok) eligible.push(trial.selection.modelProviderId);
  }
  return eligible;
}

function visualMissing(input, resolution, providers) {
  if (input.role !== 'visual_verifier' || resolution.ok) return resolution.missing;
  if (resolution.reason === 'auto_pool') return resolution.missing;
  const localOnly = input.projectPolicy?.scope?.localOnly === true;
  if (resolution.reason === 'scope' && !localOnly) return resolution.missing;
  const hasVision = providers.some((provider) => (
    provider?.supportsVision === true && (!localOnly || provider.local === true)
  ));
  if (!hasVision) {
    return localOnly
      ? '本项目只允许本地模型，但没有能看图的本地模型'
      : '没有能看图的模型';
  }
  return resolution.missing;
}

/**
 * Resolve one role and the recovery candidates that stay inside that role's filter.
 * Non-essential roles stop when the spend cap is reached. project_agent and
 * session_worker still resolve; the caller can show the cap later.
 */
export function resolveRoleRoute(input = {}) {
  const providers = Array.isArray(input.providers) ? input.providers : [];
  const routing = resolveStoredModelRouting(input.routing, providers);
  const catalog = catalogFromProviders(providers);
  const workerProvider = providerById(providers, input.workerModelProviderId);
  const workerModel = input.workerModel || (workerProvider
    ? {
        family: providerFamily(workerProvider),
        providerId: text(workerProvider.groupId) || text(workerProvider.id),
        modelProviderId: text(workerProvider.id),
      }
    : null);
  const cap = capFor(routing, input.role);
  const spend = evaluateRoleSpendCap({
    role: input.role,
    spentUsd: input.spentUsd ?? 0,
    capUsd: cap ?? Number.NaN,
  });
  if (spend.blocks) {
    return {
      ok: false,
      reason: 'spend_cap_reached',
      missing: '该角色已达到今日花费上限',
      candidateIds: [],
      spendExceeded: true,
    };
  }
  const request = {
    role: input.role,
    catalog,
    routing,
    projectPolicy: input.projectPolicy,
    taskOverride: input.taskOverride,
    requestPreference: input.requestPreference,
    workerModel,
    taskRequiresVision: input.taskRequiresVision,
    requiredContextTokens: input.requiredContextTokens,
  };
  const resolution = resolveRoleModel(request);
  if (!resolution.ok) {
    return {
      ...resolution,
      missing: visualMissing(input, resolution, providers),
      candidateIds: [],
      spendExceeded: spend.exceeded,
    };
  }
  const setting = winningSetting(input, routing, resolution.source);
  const ids = idsFromSetting(setting, routing);
  const eligible = eligibleIds(ids, { ...input, catalog }, routing, workerModel);
  const chosen = resolution.selection.modelProviderId;
  const candidateIds = [chosen, ...eligible.filter((id) => id !== chosen)];
  return {
    ...resolution,
    candidateIds,
    spendExceeded: spend.exceeded,
  };
}
