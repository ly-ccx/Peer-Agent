import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface WorkbenchInboxCounts {
  readonly needsYou: number;
  readonly resultReady: number;
}

/** 工作台侧栏徽标：只要行动权，不要纯讨论投影。 */
export function countWorkbenchInbox(
  items: readonly TaskOverviewItem[],
): WorkbenchInboxCounts {
  let needsYou = 0;
  let resultReady = 0;
  for (const item of items) {
    if (item.source === 'conversation') continue;
    if (item.actionRight === 'needs_you') needsYou += 1;
    else if (item.actionRight === 'result_ready') resultReady += 1;
  }
  return { needsYou, resultReady };
}
