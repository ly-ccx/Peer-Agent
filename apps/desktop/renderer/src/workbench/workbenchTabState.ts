export type WorkbenchTabId = 'plan' | 'browser' | 'files' | 'documents';

function isWorkbenchTab(value: unknown): value is WorkbenchTabId {
  return (
    value === 'plan' ||
    value === 'browser' ||
    value === 'files' ||
    value === 'documents'
  );
}

/** 把持久化/历史输入归一为当前一级能力入口。 */
export function normalizeWorkbenchTab(value: unknown): WorkbenchTabId | null {
  if (value === 'goal' || value === 'terminal') return 'plan';
  if (value === 'diff') return 'documents';
  return isWorkbenchTab(value) ? value : null;
}

export function normalizeWorkbenchTabMap(raw: unknown): Record<string, WorkbenchTabId> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, WorkbenchTabId> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const tab = normalizeWorkbenchTab(value);
    if (tab) out[key] = tab;
  }
  return out;
}
