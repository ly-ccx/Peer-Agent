import type { TranslationKey } from '@peer-agent/i18n';

export const MODEL_TIERS = ['strong', 'fast', 'economy', 'vision'] as const;
export const MODEL_ROLES = [
  'project_agent',
  'session_worker',
  'explorer',
  'verifier',
  'visual_verifier',
  'memory_curator',
  'objective_probe',
  'compactor',
] as const;

export type ModelTierName = (typeof MODEL_TIERS)[number];
export type ModelRoleName = (typeof MODEL_ROLES)[number];
export type OptionRejectReason = 'vision' | 'tools' | 'structured' | 'context';

export interface RoutingModelOption {
  readonly id: string;
  readonly label: string;
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  readonly supportsStructured: boolean;
  readonly contextTokens: number;
}

const EXPLORER_MIN_CONTEXT = 8_000;
const ESSENTIAL_ROLES = new Set<ModelRoleName>(['project_agent', 'session_worker']);

export function isRoutingReadOnly(providerCount: number): boolean {
  return providerCount <= 1;
}

export function isEssentialRole(role: string): boolean {
  return ESSENTIAL_ROLES.has(role as ModelRoleName);
}

export function optionRejectReason(
  option: RoutingModelOption,
  target: { readonly kind: 'tier'; readonly tier: ModelTierName } | { readonly kind: 'role'; readonly role: ModelRoleName },
): OptionRejectReason | null {
  if (target.kind === 'tier') {
    return target.tier === 'vision' && option.supportsVision !== true ? 'vision' : null;
  }
  switch (target.role) {
    case 'visual_verifier':
      return option.supportsVision === true ? null : 'vision';
    case 'explorer':
      if (option.supportsTools !== true) return 'tools';
      return option.contextTokens >= EXPLORER_MIN_CONTEXT ? null : 'context';
    case 'memory_curator':
      return option.supportsStructured === true ? null : 'structured';
    case 'compactor':
      return null;
    default:
      return option.supportsTools === true ? null : 'tools';
  }
}

export function validateAutoPool(
  pool: readonly string[],
  options: readonly RoutingModelOption[],
  role: ModelRoleName,
): { ok: true } | { ok: false; reason: 'empty' | 'unknown' | 'capability' } {
  const ids = pool.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, reason: 'empty' };
  const byId = new Map(options.map((option) => [option.id, option]));
  for (const id of ids) {
    const option = byId.get(id);
    if (!option) return { ok: false, reason: 'unknown' };
    if (optionRejectReason(option, { kind: 'role', role })) return { ok: false, reason: 'capability' };
  }
  return { ok: true };
}

export function moveListItem(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const next = [...ids];
  const index = next.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function withoutId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id);
}

export function tierTranslationKey(tier: ModelTierName): TranslationKey {
  switch (tier) {
    case 'strong': return 'modelRouting.tier.strong';
    case 'fast': return 'modelRouting.tier.fast';
    case 'economy': return 'modelRouting.tier.economy';
    case 'vision': return 'modelRouting.tier.vision';
    default: return 'modelRouting.unresolved';
  }
}

export function roleTranslationKey(role: string): TranslationKey | null {
  switch (role) {
    case 'project_agent': return 'modelRouting.role.project_agent';
    case 'session_worker': return 'modelRouting.role.session_worker';
    case 'explorer': return 'modelRouting.role.explorer';
    case 'verifier': return 'modelRouting.role.verifier';
    case 'visual_verifier': return 'modelRouting.role.visual_verifier';
    case 'memory_curator': return 'modelRouting.role.memory_curator';
    case 'objective_probe': return 'modelRouting.role.objective_probe';
    case 'compactor': return 'modelRouting.role.compactor';
    default: return null;
  }
}

export function reasonTranslationKey(reason: OptionRejectReason): TranslationKey {
  switch (reason) {
    case 'vision': return 'modelRouting.reason.vision';
    case 'tools': return 'modelRouting.reason.tools';
    case 'structured': return 'modelRouting.reason.structured';
    case 'context': return 'modelRouting.reason.context';
    default: return 'modelRouting.unresolved';
  }
}
