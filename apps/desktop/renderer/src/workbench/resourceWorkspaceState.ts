/** Presentation metadata only. Domain sessions and host authorization remain authoritative. */
export interface ResourceWorkspacePreferences {
  readonly order: readonly string[];
  readonly recent: readonly string[];
}
export const LAUNCHER_TAB = 'launcher';

/** Collapse navigation before sacrificing either reading surface. No persisted preference changes. */
export function resourceLayoutBounds(viewport: number, navigation: number, gap: number, mainMin: number, resourceMin: number) {
  const navigationCollapsed = viewport < mainMin + navigation + resourceMin + 3 * gap;
  const primaryMin = mainMin + (navigationCollapsed ? 0 : navigation) + 2 * gap;
  return { navigationCollapsed, primaryMin, compact: viewport < primaryMin + resourceMin + gap,
    sideMax: Math.max(resourceMin, viewport - primaryMin - gap) };
}
export function resourceKey(kind: 'document' | 'browser', id: string): string { return `${kind}:${id}`; }

export function reconcileResourceOrder(order: readonly string[], available: readonly string[]): readonly string[] {
  const live = new Set(available);
  return [...new Set([...order.filter(key => live.has(key)), ...available])];
}

export function resourceNeighbor(order: readonly string[], closed: string): string {
  const index = order.indexOf(closed);
  return index < 0 ? LAUNCHER_TAB : order[index + 1] ?? order[index - 1] ?? LAUNCHER_TAB;
}

export function normalizeResourcePreferences(raw: unknown): ResourceWorkspacePreferences {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strings = (input: unknown, max: number) => Array.isArray(input)
    ? [...new Set(input.filter((key): key is string => typeof key === 'string' && key.length < 8192))].slice(0, max) : [];
  return { order: strings(value.order, 200), recent: strings(value.recent, 16) };
}

/** No bare command/search text becomes a browser navigation. */
export function resourceWebUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
