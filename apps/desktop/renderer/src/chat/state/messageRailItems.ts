import type { MessageRailItem } from '../components/thread/MessageRail';
import type { ChatMsg } from './types';

export interface MessageRailItemCache {
  readonly messageCount: number;
  readonly lastMessageId: string | null;
  readonly items: readonly MessageRailItem[];
}

export function buildMessageRailItems(
  messages: readonly ChatMsg[],
  compactionLabel: string,
): MessageRailItem[] {
  let railMessageNumber = 0;
  return messages.flatMap<MessageRailItem>((message) => {
    if (message.compaction) {
      return [{
        kind: 'compaction',
        id: message.id,
        text: compactionLabel,
      }];
    }
    if (message.role !== 'user') return [];

    railMessageNumber += 1;
    const raw = (message.content ?? '').trim();
    const text = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    return [{ kind: 'message', id: message.id, text, messageNumber: railMessageNumber }];
  });
}

/**
 * 流式阶段只会替换同长度消息数组的末尾 assistant 消息；此时消息轨不会变化，
 * 直接复用上次结果。编辑、压缩、切换会话等路径由调用者关闭 tailOnly 并完整重算。
 */
export function buildMessageRailItemsIncremental(
  messages: readonly ChatMsg[],
  compactionLabel: string,
  previous?: MessageRailItemCache,
  tailOnly: boolean = false,
): MessageRailItemCache {
  const canReuse = Boolean(
    tailOnly
    && previous
    && messages.length === previous.messageCount
    && messages.at(-1)?.role === 'assistant'
    && messages.at(-1)?.id === previous.lastMessageId
    && !messages.at(-1)?.compaction,
  );
  if (canReuse && previous) return previous;

  return {
    messageCount: messages.length,
    lastMessageId: messages.at(-1)?.id ?? null,
    items: buildMessageRailItems(messages, compactionLabel),
  };
}
