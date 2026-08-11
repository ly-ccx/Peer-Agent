import type { ChatTurn } from './chatTurns';

/** ChatTurn memo 边界真正关心的渲染输入；回调与运行时对象只比较引用。 */
export interface ChatTurnRenderIdentity {
  readonly conversationId: string | null;
  readonly turn: ChatTurn;
  readonly isLive: boolean;
  readonly streamStartedAt: number | null;
  readonly isZh: boolean;
  readonly i18n: unknown;
  readonly onMessageAction: unknown;
  readonly onBeginEdit: unknown;
  readonly onRegenerate: unknown;
  readonly onPreviewImage: unknown;
  readonly turnIndex: number;
  readonly onMeasure: unknown;
}

/**
 * 已完成轮次即使父层因流式 delta 重渲染，只要消息引用与交互输入未变就继续复用。
 * 活动轮次的末尾消息对象会随 delta 替换，因此会按预期重新渲染。
 */
export function areChatTurnRenderPropsEqual(
  previous: ChatTurnRenderIdentity,
  next: ChatTurnRenderIdentity,
): boolean {
  if (
    previous.conversationId !== next.conversationId
    || previous.turn.id !== next.turn.id
    || previous.turn.messages.length !== next.turn.messages.length
    || previous.isLive !== next.isLive
    || previous.streamStartedAt !== next.streamStartedAt
    || previous.isZh !== next.isZh
    || previous.i18n !== next.i18n
    || previous.onMessageAction !== next.onMessageAction
    || previous.onBeginEdit !== next.onBeginEdit
    || previous.onRegenerate !== next.onRegenerate
    || previous.onPreviewImage !== next.onPreviewImage
    || previous.turnIndex !== next.turnIndex
    || previous.onMeasure !== next.onMeasure
  ) {
    return false;
  }

  return previous.turn.messages.every((entry, index) => {
    const candidate = next.turn.messages[index];
    return entry.msg === candidate?.msg
      && entry.index === candidate.index
      && entry.answeredText === candidate.answeredText;
  });
}
