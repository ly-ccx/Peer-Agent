const FALLBACK_SESSION_KEY = '__none';

export type WorkbenchOpenMap = Record<string, boolean>;

export function workbenchOpenKey(conversationId: string | null): string {
  return conversationId ?? FALLBACK_SESSION_KEY;
}

export function normalizeWorkbenchOpenMap(raw: unknown): WorkbenchOpenMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: WorkbenchOpenMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function resolveWorkbenchOpen(
  map: WorkbenchOpenMap,
  conversationId: string | null,
  legacyDefault = false,
): boolean {
  return map[workbenchOpenKey(conversationId)] ?? legacyDefault;
}

export function updateWorkbenchOpen(
  map: WorkbenchOpenMap,
  conversationId: string | null,
  open: boolean,
): WorkbenchOpenMap {
  const key = workbenchOpenKey(conversationId);
  return map[key] === open ? map : { ...map, [key]: open };
}
