import { resolveRoleRoute } from '@peer-agent/runtime-node';

const ROLES = ['project_agent', 'session_worker', 'verifier', 'explorer', 'visual_verifier', 'memory_curator', 'objective_probe', 'compactor'];

/** Cheap read projection using the routing kernel, without reading the usage ledger. */
export function projectBotModelViews({ providers = [], routing, projectPolicy } = {}) {
  const views = {};
  const worker = resolveRoleRoute({ role: 'session_worker', providers, routing, projectPolicy });
  for (const role of ROLES) {
    const input = { role, providers, routing, projectPolicy,
      workerModelProviderId: worker.ok ? worker.selection.modelProviderId : null };
    const route = resolveRoleRoute(input);
    views[role] = {
      resolution: route.ok
        ? { ok: true, selection: route.selection, source: route.source, ...(role === 'verifier' ? { sameFamilyAsWorker: route.sameFamilyAsWorker } : {}) }
        : { ok: false, reason: route.reason, missing: route.missing },
      eligibleModelIds: providers.filter(provider => resolveRoleRoute({ ...input,
        projectPolicy: { ...projectPolicy, overrides: { ...projectPolicy?.overrides, [role]: { mode: 'fixed', modelProviderId: provider.id } } },
      }).ok).map(provider => provider.id),
    };
  }
  return views;
}
