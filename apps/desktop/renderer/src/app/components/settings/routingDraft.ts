import type { ModelRoutingPatch, ModelRoutingView } from '../../../preload/contracts/bootstrapPreloadApi';

export interface RoutingDraft { readonly view: ModelRoutingView; readonly caps: Readonly<Record<string, string>> }
export function readRoutingDraft(view: ModelRoutingView): RoutingDraft {
  return { view, caps: Object.fromEntries(Object.entries(view.routing.roleSpendCaps ?? {}).map(([role, value]) => [role, String(value)])) };
}
export function editRoutingDraft(draft: RoutingDraft, patch: ModelRoutingPatch): RoutingDraft {
  const caps = { ...draft.caps };
  for (const [role, value] of Object.entries(patch.roleSpendCaps ?? {})) caps[role] = value == null ? '' : String(value);
  return { caps, view: { ...draft.view, routing: { ...draft.view.routing, ...patch,
    tiers: { ...draft.view.routing.tiers, ...patch.tiers }, roles: { ...draft.view.routing.roles, ...patch.roles },
    roleSpendCaps: draft.view.routing.roleSpendCaps,
  } } };
}
export function routingDraftPatch(draft: RoutingDraft, saved: RoutingDraft): ModelRoutingPatch {
  const tiers = Object.fromEntries(Object.entries(draft.view.routing.tiers).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved.view.routing.tiers[key as keyof typeof saved.view.routing.tiers])));
  const roles = Object.fromEntries(Object.entries(draft.view.routing.roles).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved.view.routing.roles[key as keyof typeof saved.view.routing.roles])));
  const caps: Record<string, number | null> = {};
  for (const role of new Set([...Object.keys(saved.caps), ...Object.keys(draft.caps)])) {
    const raw = draft.caps[role]?.trim() ?? '', old = saved.caps[role]?.trim() ?? '';
    if (raw === old) continue;
    if (raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) throw Error('INVALID_SPEND_CAP');
    caps[role] = raw === '' ? null : Number(raw);
  }
  return { ...(Object.keys(tiers).length ? { tiers } : {}), ...(Object.keys(roles).length ? { roles } : {}),
    ...(Object.keys(caps).length ? { roleSpendCaps: caps } : {}),
    ...(draft.view.routing.verifierPreferDifferentFamily !== saved.view.routing.verifierPreferDifferentFamily ? { verifierPreferDifferentFamily: draft.view.routing.verifierPreferDifferentFamily } : {}),
  };
}
