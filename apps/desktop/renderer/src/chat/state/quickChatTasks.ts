import type { GoalPlan } from '@peer-agent/protocol';
import { parseInteractionToolViewFromCandidates, type InteractionToolView } from './interactionToolView.ts';
import type { ChatMsg, ContentSegment } from './types.ts';

export interface QuickChatInteractionTask {
  readonly kind: 'interaction';
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly workspacePath: string;
  readonly assistantMessageId: string;
  readonly view: InteractionToolView;
  readonly createdAt: number;
}

export interface QuickChatPlanTask {
  readonly kind: 'plan-approval';
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly workspacePath: string;
  readonly plan: GoalPlan;
  readonly createdAt: number;
}

export type QuickChatTask = QuickChatInteractionTask | QuickChatPlanTask;

export interface QuickChatTaskConversation {
  readonly id: string;
  readonly title: string;
  readonly workspacePath: string;
  readonly messages: readonly ChatMsg[];
}

function interactionFromSegment(segment: ContentSegment): InteractionToolView | null {
  if (segment.type !== 'tool-call') return null;
  return parseInteractionToolViewFromCandidates(
    [segment.tool, segment.displayName],
    [segment.args, segment.result],
  );
}

/**
 * Projects unresolved request_user_input tool results into Quick Chat task cards.
 * Conversation messages remain the source of truth: any later user message resolves the request.
 */
export function projectQuickChatTasks(
  conversations: readonly QuickChatTaskConversation[],
): QuickChatInteractionTask[] {
  const tasks: QuickChatInteractionTask[] = [];

  for (const conversation of conversations) {
    for (let messageIndex = conversation.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = conversation.messages[messageIndex];
      if (message.role === 'user') break;
      if (message.role !== 'assistant') continue;

      const segments = message.segments ?? [];
      let view: InteractionToolView | null = null;
      for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        view = interactionFromSegment(segments[segmentIndex]);
        if (view) break;
      }
      if (!view) continue;

      tasks.push({
        kind: 'interaction',
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        workspacePath: conversation.workspacePath,
        assistantMessageId: message.id,
        view,
        createdAt: message.timestamp ?? 0,
      });
      break;
    }
  }

  return tasks.sort((left, right) => right.createdAt - left.createdAt);
}

export function projectQuickChatPlanTasks(
  plans: readonly GoalPlan[],
  conversations: readonly Pick<QuickChatTaskConversation, 'id' | 'title' | 'workspacePath'>[],
): QuickChatPlanTask[] {
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return plans
    .filter((plan) => plan.status === 'awaiting_approval' && Boolean(plan.conversationId))
    .map((plan) => {
      const conversation = conversationById.get(plan.conversationId ?? '');
      return {
        kind: 'plan-approval' as const,
        conversationId: plan.conversationId ?? '',
        conversationTitle: conversation?.title ?? plan.title,
        workspacePath: plan.originWorkspacePath ?? conversation?.workspacePath ?? '',
        plan,
        createdAt: Date.parse(plan.createdAt) || 0,
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function mergeQuickChatTasks(
  planTasks: readonly QuickChatPlanTask[],
  interactionTasks: readonly QuickChatInteractionTask[],
): QuickChatTask[] {
  return [...planTasks, ...interactionTasks].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'plan-approval' ? -1 : 1;
    return right.createdAt - left.createdAt;
  });
}
