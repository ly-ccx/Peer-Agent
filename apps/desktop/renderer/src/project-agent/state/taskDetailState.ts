import type { DrawerSession } from './drawerState';

/** Live list facts own status; the matching detail supplies the report omitted by lists. */
export function mergeTaskDetail(selected: DrawerSession | null, detail: DrawerSession | null): DrawerSession | null {
  if (!selected) return detail;
  if (!detail || detail.sessionId !== selected.sessionId) return selected;
  return { ...detail, ...selected, summary: detail.summary, evidenceRefs: detail.evidenceRefs };
}
