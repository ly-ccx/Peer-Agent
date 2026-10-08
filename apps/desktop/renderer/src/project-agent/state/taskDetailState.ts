import type { DrawerSession } from './drawerState';
import { readDrawerSession } from './drawerState.ts';

export type TaskReportState = 'loading' | 'ready' | 'unavailable';

/** Failed refreshes retain a matching report; deletion and foreign IDs cannot supply it. */
export function settleTaskReport(sessionId: string, result: { ok?: boolean; session?: unknown; code?: string } | null,
  previous: DrawerSession | null): { detail: DrawerSession | null; state: TaskReportState } {
  const detail = result?.ok ? readDrawerSession(result.session) : null;
  if (detail?.sessionId === sessionId) return { detail, state: 'ready' };
  return { detail: result?.code === 'NOT_FOUND' ? null : previous?.sessionId === sessionId ? previous : null, state: 'unavailable' };
}

/** Live list facts own status; the matching detail supplies the report omitted by lists. */
export function mergeTaskDetail(selected: DrawerSession | null, detail: DrawerSession | null): DrawerSession | null {
  if (!selected) return detail;
  if (!detail || detail.sessionId !== selected.sessionId) return selected;
  return { ...detail, ...selected, summary: detail.summary, evidenceRefs: detail.evidenceRefs };
}
