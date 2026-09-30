const ROLES = new Set(['project_agent', 'session_worker', 'explorer', 'verifier', 'visual_verifier', 'memory_curator', 'objective_probe', 'compactor']);
const TIERS = new Set(['strong', 'fast', 'economy', 'vision']);

/** Validate the whole patch before any profile write; a project only narrows configured models. */
export function profilePolicyPatch(payload, models = []) {
  const patch = {};
  if (payload.planApproval !== undefined) {
    if (!['never', 'writes', 'always'].includes(payload.planApproval)) return { ok: false, code: 'INVALID_PLAN_APPROVAL' };
    patch.planApproval = payload.planApproval;
  }
  if (payload.acceptancePolicy !== undefined) {
    if (!['auto', 'confirm'].includes(payload.acceptancePolicy)) return { ok: false, code: 'INVALID_ACCEPTANCE_POLICY' };
    patch.acceptancePolicy = payload.acceptancePolicy;
  }
  if (payload.modelPolicy !== undefined) {
    if (payload.modelPolicy === null) patch.modelPolicy = null;
    else {
      const policy = payload.modelPolicy;
      const allowed = new Set(models.filter((model) => model.enabled !== false).map((model) => model.id));
      const ids = (value) => Array.isArray(value) && value.length <= 100 && value.every((id) => typeof id === 'string' && allowed.has(id));
      const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
      if (!object(policy) || Object.keys(policy).some((key) => !['scope', 'overrides'].includes(key))) return { ok: false, code: 'INVALID_MODEL_POLICY' };
      if (policy.scope != null) {
        const scope = policy.scope;
        if (!object(scope) || Object.keys(scope).some((key) => !['modelProviderIds', 'families', 'localOnly'].includes(key))
          || scope.modelProviderIds !== undefined && !ids(scope.modelProviderIds)
          || scope.families !== undefined && (!Array.isArray(scope.families) || scope.families.length > 100 || !scope.families.every((family) => typeof family === 'string' && family.trim() && family.length <= 100))
          || scope.localOnly !== undefined && typeof scope.localOnly !== 'boolean') return { ok: false, code: 'INVALID_MODEL_POLICY' };
      }
      if (policy.overrides != null) {
        if (!object(policy.overrides)) return { ok: false, code: 'INVALID_MODEL_POLICY' };
        for (const [role, setting] of Object.entries(policy.overrides)) {
          if (!ROLES.has(role) || !object(setting)) return { ok: false, code: 'INVALID_MODEL_POLICY' };
          const valid = setting.mode === 'tier' && TIERS.has(setting.tier)
            || setting.mode === 'fixed' && allowed.has(setting.modelProviderId)
            || setting.mode === 'auto' && ids(setting.pool) && setting.pool.length > 0;
          if (!valid) return { ok: false, code: 'INVALID_MODEL_POLICY' };
        }
      }
      patch.modelPolicy = policy;
    }
  }
  return { ok: true, patch };
}
