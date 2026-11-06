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

export interface ChatTurnVirtualizationWeight {
  readonly turnCount: number;
  readonly segmentCount: number;
  readonly maxTurnSegmentCount: number;
  readonly toolCallCount: number;
  readonly maxTurnToolCallCount: number;
  readonly paragraphCount: number;
  readonly maxTurnParagraphCount: number;
  readonly textChars: number;
  readonly maxTurnTextChars: number;
  readonly attachmentBytes: number;
  readonly maxTurnAttachmentBytes: number;
}

const VIRTUAL_TURN_COUNT_THRESHOLD = 20;
const VIRTUAL_SEGMENT_COUNT_THRESHOLD = 120;
const VIRTUAL_MAX_TURN_SEGMENT_THRESHOLD = 60;
const VIRTUAL_TOOL_CALL_COUNT_THRESHOLD = 80;
const VIRTUAL_MAX_TURN_TOOL_CALL_THRESHOLD = 12;
const VIRTUAL_PARAGRAPH_COUNT_THRESHOLD = 18;
const VIRTUAL_MAX_TURN_PARAGRAPH_THRESHOLD = 10;
const VIRTUAL_TEXT_CHARS_THRESHOLD = 8_000;
const VIRTUAL_MAX_TURN_TEXT_CHARS_THRESHOLD = 4_000;
const VIRTUAL_FENCE_LINES_PER_PARAGRAPH = 8;
const VIRTUAL_ATTACHMENT_BYTES_THRESHOLD = 768 * 1024;
const VIRTUAL_ATTACHMENT_MIN_TURN_COUNT = 3;

/** 段落、围栏行数和正文字符。短回合只要其中一项过重就该提前虚拟化。 */
export function measureTextComplexity(content: string): { readonly paragraphs: number; readonly chars: number } {
  const chars = content.length;
  if (!content.trim()) return { paragraphs: 0, chars };
  let paragraphs = 0;
  for (const chunk of content.split(/\n{2,}/)) {
    if (chunk.trim()) paragraphs += 1;
  }
  let fenceLines = 0;
  let inFence = false;
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) fenceLines += 1;
  }
  paragraphs += Math.floor(fenceLines / VIRTUAL_FENCE_LINES_PER_PARAGRAPH);
  return { paragraphs, chars };
}

export function getChatTurnVirtualizationWeight(
  turns: readonly ChatTurn[],
): ChatTurnVirtualizationWeight {
  let segmentCount = 0;
  let maxTurnSegmentCount = 0;
  let toolCallCount = 0;
  let maxTurnToolCallCount = 0;
  let paragraphCount = 0;
  let maxTurnParagraphCount = 0;
  let textChars = 0;
  let maxTurnTextChars = 0;
  let attachmentBytes = 0;
  let maxTurnAttachmentBytes = 0;

  for (const turn of turns) {
    let turnSegmentCount = 0;
    let turnAttachmentBytes = 0;
    let turnToolCallCount = 0;
    let turnParagraphCount = 0;
    let turnTextChars = 0;
    for (const { msg } of turn.messages) {
      const segments = msg.segments ?? [];
      turnSegmentCount += segments.length;
      let sawText = false;
      let text = '';
      for (const segment of segments) {
        if (segment.type === 'tool-call') {
          toolCallCount += 1;
          turnToolCallCount += 1;
        } else if (segment.type === 'text') {
          sawText = true;
          text += segment.content || '';
        }
      }
      if (!sawText && msg.content) text = msg.content;
      const complexity = measureTextComplexity(text);
      turnParagraphCount += complexity.paragraphs;
      turnTextChars += complexity.chars;
      for (const attachment of msg.attachments ?? []) {
        turnAttachmentBytes += Math.max(0, attachment.size || 0);
      }
    }
    segmentCount += turnSegmentCount;
    maxTurnSegmentCount = Math.max(maxTurnSegmentCount, turnSegmentCount);
    maxTurnToolCallCount = Math.max(maxTurnToolCallCount, turnToolCallCount);
    paragraphCount += turnParagraphCount;
    maxTurnParagraphCount = Math.max(maxTurnParagraphCount, turnParagraphCount);
    textChars += turnTextChars;
    maxTurnTextChars = Math.max(maxTurnTextChars, turnTextChars);
    attachmentBytes += turnAttachmentBytes;
    maxTurnAttachmentBytes = Math.max(maxTurnAttachmentBytes, turnAttachmentBytes);
  }

  return {
    turnCount: turns.length,
    segmentCount,
    maxTurnSegmentCount,
    toolCallCount,
    maxTurnToolCallCount,
    paragraphCount,
    maxTurnParagraphCount,
    textChars,
    maxTurnTextChars,
    attachmentBytes,
    maxTurnAttachmentBytes,
  };
}

export function shouldVirtualizeChatTurns(
  turns: readonly ChatTurn[],
  findOpen: boolean,
): boolean {
  if (findOpen) return false;
  const weight = getChatTurnVirtualizationWeight(turns);
  return weight.turnCount > VIRTUAL_TURN_COUNT_THRESHOLD
    || weight.segmentCount > VIRTUAL_SEGMENT_COUNT_THRESHOLD
    || weight.maxTurnSegmentCount > VIRTUAL_MAX_TURN_SEGMENT_THRESHOLD
    || weight.toolCallCount > VIRTUAL_TOOL_CALL_COUNT_THRESHOLD
    || weight.maxTurnToolCallCount > VIRTUAL_MAX_TURN_TOOL_CALL_THRESHOLD
    || weight.paragraphCount > VIRTUAL_PARAGRAPH_COUNT_THRESHOLD
    || weight.maxTurnParagraphCount > VIRTUAL_MAX_TURN_PARAGRAPH_THRESHOLD
    || weight.textChars > VIRTUAL_TEXT_CHARS_THRESHOLD
    || weight.maxTurnTextChars > VIRTUAL_MAX_TURN_TEXT_CHARS_THRESHOLD
    || (
      weight.turnCount >= VIRTUAL_ATTACHMENT_MIN_TURN_COUNT
      && weight.attachmentBytes >= VIRTUAL_ATTACHMENT_BYTES_THRESHOLD
    );
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
