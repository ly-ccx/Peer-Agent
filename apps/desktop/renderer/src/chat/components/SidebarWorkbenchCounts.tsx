import { memo, useMemo } from 'react';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { countWorkbenchInbox } from '../state/workbenchInboxCounts';

/**
 * 工作台顶部「需要你」计数。
 * 单独挂载 useTaskOverview，避免兜底轮询/推送牵动整棵会话列表重绘。
 */
export const SidebarWorkbenchCounts = memo(function SidebarWorkbenchCounts({
  isZh,
}: {
  readonly isZh: boolean;
}) {
  const overviewItems = useTaskOverview({ workspacePath: null, includeTerminal: false });
  const inboxCounts = useMemo(() => countWorkbenchInbox(overviewItems), [overviewItems]);

  if (inboxCounts.needsYou <= 0) {
    return null;
  }

  const label = isZh
    ? `需要你 ${inboxCounts.needsYou}`
    : `Needs you ${inboxCounts.needsYou}`;

  return (
    <span
      className="sidebar-workbench-counts"
      title={label}
    >
      {label}
    </span>
  );
});
