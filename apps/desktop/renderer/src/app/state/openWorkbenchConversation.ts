import type { TaskOverviewItem } from '@peer-agent/protocol';

export function blockedPlanIdsFromItem(item: TaskOverviewItem): readonly string[] {
  if (Array.isArray(item.blockedPlanIds) && item.blockedPlanIds.length > 0) {
    return item.blockedPlanIds.filter(Boolean);
  }
  if (item.taskId && !item.taskId.startsWith('source-block:')) return [item.taskId];
  return [];
}

export async function resolveWorkbenchConversationId(
  item: TaskOverviewItem,
  getPlan: (planId: string) => Promise<{ conversationId?: string | null } | null> = async (planId) => {
    const { clientApi } = await import('../../clientApi');
    return clientApi.goalPlansGet({ planId });
  },
): Promise<string | null> {
  if (item.conversationId) return String(item.conversationId);
  for (const planId of blockedPlanIdsFromItem(item)) {
    try {
      const plan = await getPlan(planId);
      if (plan?.conversationId) return String(plan.conversationId);
    } catch {
      // Keep scanning remaining blocked plans.
    }
  }
  return null;
}
