import type { TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { loadConversationMessages } from './conversationLoad';
import { findTaskRelatedMessageId } from './taskRelatedMessage';

export async function resolveTaskRelatedMessageId(item: TaskOverviewItem): Promise<string | null> {
  if (!item.conversationId) return null;
  try {
    const [loaded, plan] = await Promise.all([
      loadConversationMessages(String(item.conversationId)),
      item.source === 'goal_plan' && item.taskId
        ? clientApi.goalPlansGet({ planId: item.taskId }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return findTaskRelatedMessageId(loaded.messages, item, plan);
  } catch {
    return null;
  }
}
