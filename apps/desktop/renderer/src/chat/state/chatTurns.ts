import type { ChatMsg } from './types';

export interface ChatTurnMessage {
  readonly msg: ChatMsg;
  readonly index: number;
  /** 紧邻该 assistant 消息的 user 回复；供交互卡锁定已选项。 */
  readonly answeredText: string | null;
}

export interface ChatTurn {
  readonly id: string;
  readonly messages: ChatTurnMessage[];
}

/**
 * 把连续消息分组为以 user 消息开头的渲染轮次。
 *
 * 保留原始 ChatMsg 引用，便于 memo 化的 ChatTurn 在只有末尾流式消息变化时
 * 跳过所有已完成历史轮次。
 */
export interface ChatTurnGroupCache {
  readonly messages: readonly ChatMsg[];
  /** 完整分组时建立的稳定数组；流式更新不复制它。 */
  readonly turns: readonly ChatTurn[];
  /** 流式更新期间覆盖 turns 的最后一项。 */
  readonly liveTurn: ChatTurn | null;
  readonly messageTurnIndex: ReadonlyMap<string, number>;
}

export function groupMessagesIntoTurns(messages: readonly ChatMsg[]): ChatTurn[] {
  const turns: ChatTurn[] = [];

  messages.forEach((msg, index) => {
    if (msg.role === 'user' || turns.length === 0) {
      turns.push({ id: msg.id, messages: [] });
    }

    turns[turns.length - 1]?.messages.push({
      msg,
      index,
      answeredText:
        msg.role === 'assistant' && messages[index + 1]?.role === 'user'
          ? messages[index + 1]?.content.trim() || null
          : null,
    });
  });

  return turns;
}

/**
 * 流式正文只替换最后一条 assistant 消息时，复用全部历史轮次，仅克隆末尾轮次。
 * 其他结构变化回退到完整分组。
 */
export function groupMessagesIntoTurnsIncremental(
  messages: readonly ChatMsg[],
  previous?: ChatTurnGroupCache,
  tailOnly: boolean = false,
): ChatTurnGroupCache {
  const canPatchTail = Boolean(
    tailOnly
    && previous
    && messages.length === previous.messages.length
    && messages.length > 0
    && messages[messages.length - 1]?.role === 'assistant'
    && messages.at(-1)?.id === previous.messages.at(-1)?.id,
  );

  if (!canPatchTail || !previous) {
    const turns = groupMessagesIntoTurns(messages);
    return { messages, turns, liveTurn: null, messageTurnIndex: buildMessageTurnIndex(turns) };
  }

  const lastTurn = previous.liveTurn ?? previous.turns.at(-1);
  if (!lastTurn) {
    const turns = groupMessagesIntoTurns(messages);
    return { messages, turns, liveTurn: null, messageTurnIndex: buildMessageTurnIndex(turns) };
  }
  const lastMessageIndex = messages.length - 1;
  const patchedMessages = lastTurn.messages.map((entry) =>
    entry.index === lastMessageIndex
      ? { ...entry, msg: messages[lastMessageIndex]! }
      : entry,
  );
  return {
    messages,
    turns: previous.turns,
    liveTurn: { ...lastTurn, messages: patchedMessages },
    messageTurnIndex: previous.messageTurnIndex,
  };
}

export function getTurnUserMessage(turn: ChatTurn): ChatMsg | null {
  return turn.messages.find(({ msg }) => msg.role === 'user')?.msg ?? null;
}

export function buildMessageTurnIndex(turns: readonly ChatTurn[]): ReadonlyMap<string, number> {
  const indexByMessageId = new Map<string, number>();
  turns.forEach((turn, turnIndex) => {
    turn.messages.forEach(({ msg }) => indexByMessageId.set(msg.id, turnIndex));
  });
  return indexByMessageId;
}

/** 流式更新期间，只有包含最新 assistant 消息的末尾轮次应视为活动轮次。 */
export function isLiveChatTurn(
  turn: ChatTurn,
  lastMessage: ChatMsg | undefined,
  isStreaming: boolean,
): boolean {
  return Boolean(isStreaming && lastMessage && turn.messages.some(({ msg }) => msg === lastMessage));
}
