import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface WorkbenchInboxCounts {
  readonly needsYou: number;
}

/** 工作台侧栏徽标：只统计「需要你」，不要讨论投影，也不把完成项算进来。 */
export function countWorkbenchInbox(
  items: readonly TaskOverviewItem[],
): WorkbenchInboxCounts {
  let needsYou = 0;
  for (const item of items) {
    if (item.source === 'conversation') continue;
    if (item.actionRight === 'needs_you') needsYou += 1;
  }
  return { needsYou };
}
