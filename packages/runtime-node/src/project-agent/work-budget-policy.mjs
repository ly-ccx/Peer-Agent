const CAPS = { maxModelRequests: 'modelRequests', maxToolCalls: 'toolCalls', maxTokens: 'tokens', maxCostUsd: 'costUsd' };
const LEGACY = { maxModelRequests: 256, maxToolCalls: 2048, source: 'system:execution-continuity-v1' };
export const DEFAULT_WORK_BUDGET = Object.freeze({ schemaVersion: 2, source: 'system:progress-continuity-v2' });

export function resolveWorkBudgetPolicy(config = {}) {
  if (config === null) config = {};
  if (typeof config !== 'object' || Array.isArray(config)) throw Error('work_budget_policy_invalid');
  const caps = {};
  for (const key of Object.keys(CAPS)) if (config[key] !== undefined) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw Error('work_budget_policy_invalid');
    caps[key] = config[key];
  }
  return { ...DEFAULT_WORK_BUDGET, ...(Object.keys(caps).length ? { source: 'settings:execution-budget' } : {}), ...caps };
}

function obsolete(limits) {
  return limits?.source === LEGACY.source && limits.maxModelRequests === LEGACY.maxModelRequests
    && limits.maxToolCalls === LEGACY.maxToolCalls && limits.maxTokens === undefined && limits.maxCostUsd === undefined;
}
export function effectiveWorkLimits(budget, policy = DEFAULT_WORK_BUDGET) {
  const old = budget?.limits;
  // An absent settings adapter cannot revoke an explicit or unrecognised stored policy.
  return policy.source === DEFAULT_WORK_BUDGET.source && old && !obsolete(old)
    && Object.keys(CAPS).some(key => old[key] !== undefined) ? old : policy;
}

/** Returns factual stop data; no implicit default allowance or zero for unknown usage. */
export function budgetBoundary(budget = {}, limits = DEFAULT_WORK_BUDGET, keys = Object.keys(CAPS)) {
  for (const cap of keys) {
    if (limits[cap] === undefined) continue;
    const metric = CAPS[cap], used = budget[metric] ?? 0;
    const unknown = cap === 'maxTokens' && (budget.unknownUsage || budget.modelRequests > 0 && budget.tokens === undefined)
      || cap === 'maxCostUsd' && (budget.unknownCost || budget.modelRequests > 0 && budget.costUsd === undefined);
    if (!Number.isFinite(limits[cap]) || limits[cap] < 0 || !Number.isFinite(used) || used < 0 || unknown || used >= limits[cap]) {
      return { metric, used: Number.isFinite(used) && used >= 0 ? used : null, limit: limits[cap],
        source: limits.source || 'legacy:unknown', reason: unknown ? 'usage_unknown' : 'limit_reached' };
    }
  }
  return null;
}

export function budgetReservationBoundary(budget) {
  const limits = budget.limits;
  if (limits.maxCostUsd === undefined && limits.maxTokens === undefined) return undefined;
  const metric = limits.maxCostUsd !== undefined ? 'costUsd' : 'tokens';
  return { metric, used: budget[metric] ?? 0, limit: limits[metric === 'costUsd' ? 'maxCostUsd' : 'maxTokens'],
    source: limits.source, reason: 'reservation_pending' };
}

/** Adds policy provenance only. The coordinator must separately admit a stopped work. */
export function legacyBudgetMigration(work, policy, at = new Date().toISOString()) {
  const budget = work?.budget;
  if (!obsolete(budget?.limits) || policy.source !== DEFAULT_WORK_BUDGET.source || budget.policyMigration) return null;
  return { ...budget, limits: { ...policy }, policyMigration: { version: 2,
    reason: 'legacy_system_default_removed', previousLimits: { ...budget.limits }, at } };
}
