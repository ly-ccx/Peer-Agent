import { memo, useMemo } from 'react';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { countWorkbenchInbox } from '../state/workbenchInboxCounts';

/**
 * 工作台顶部「需要你 / 待验收」计数。
 * 单独挂载 useTaskOverview，避免兜底轮询/推送牵动整棵会话列表重绘。
 */
export const SidebarWorkbenchCounts = memo(function SidebarWorkbenchCounts({
  isZh,
}: {
  readonly isZh: boolean;
}) {
  const overviewItems = useTaskOverview({ workspacePath: null, includeTerminal: false });
  const inboxCounts = useMemo(() => countWorkbenchInbox(overviewItems), [overviewItems]);

  if (inboxCounts.needsYou <= 0 && inboxCounts.resultReady <= 0) {
    return null;
  }

  return (
    <span
      className="sidebar-workbench-counts"
      title={
        isZh
          ? `需要你 ${inboxCounts.needsYou} · 待验收 ${inboxCounts.resultReady}`
          : `Needs you ${inboxCounts.needsYou} · Ready ${inboxCounts.resultReady}`
      }
    >
      {isZh
        ? `需要你 ${inboxCounts.needsYou} · 待验收 ${inboxCounts.resultReady}`
        : `Needs you ${inboxCounts.needsYou} · Ready ${inboxCounts.resultReady}`}
    </span>
  );
});
