export type WorkbenchTabId = 'plan' | 'monitor' | 'browser' | 'files' | 'documents';

function isWorkbenchTab(value: unknown): value is WorkbenchTabId {
  return (
    value === 'plan' ||
    value === 'monitor' ||
    value === 'browser' ||
    value === 'files' ||
    value === 'documents'
  );
}

/** 把持久化/历史输入归一为当前一级能力入口。 */
export function normalizeWorkbenchTab(value: unknown): WorkbenchTabId | null {
  if (value === 'goal' || value === 'terminal') return 'plan';
  if (value === 'diff') return 'documents';
  // Retired background tabs must never restore a blank, duplicate management surface.
  if (value === 'background' || value === 'shell' || value === 'threads') return 'plan';
  // 2026-09-15 重构：任务上下文栏重定位为「任务监控栏」（环境信息移回对话面板
  // composer，后台任务内联合并），旧 'context' 持久化值归一到新入口。
  if (value === 'context') return 'monitor';
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
