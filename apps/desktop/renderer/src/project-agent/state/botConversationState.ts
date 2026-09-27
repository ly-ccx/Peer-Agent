/**
 * 机器人对话的纯投影。分页、乐观发送和时间分隔都不碰 IPC。
 * 输入队列落盘的用户消息可能没有 kind，按 user_input 显示。
 * agent_turn 的内部文本不进入列表，但它的工具调用用来推导用户消息上的处置标记。
 * 模型不能直接写处置。
 */
import type { TranslationKey } from '@peer-agent/i18n';
import {
  dispositionEventsFromToolCalls,
  projectMessageDispositions,
  type DispositionEvent,
  type DispositionMessage,
  type DispositionToolCall,
  type MessageDisposition,
} from '@peer-agent/protocol';

export const CONVERSATION_PAGE_SIZE = 50;
export const CONVERSATION_GAP_MS = 10 * 60 * 1000;
export const CONVERSATION_WINDOW_THRESHOLD = 200;

export interface BotChatMark {
  readonly sessionId?: string;
  readonly outcome?: string;
  readonly verdictRef?: string;
}

export interface BotChatCardAction {
  readonly id: string;
  readonly channel?: string;
  readonly seam?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface BotChatCard {
  readonly cardId: string;
  readonly kind: string;
  readonly content: string;
  readonly resolvedState?: 'open' | 'resolved';
  readonly actions?: readonly BotChatCardAction[];
}

export interface BotChatMeta {
  readonly replyTo?: readonly string[];
  readonly sources?: readonly string[];
  readonly memoryUsed?: readonly string[];
  readonly memoryLearned?: readonly string[];
  readonly surfacing?: string;
  readonly separatorLabel?: string;
}

export interface BotToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface BotToolRound {
  readonly text: string;
  readonly toolCalls: readonly BotToolCall[];
}

export interface BotDispositionMark {
  readonly kind: MessageDisposition['kind'];
  readonly sessionIds: readonly string[];
  readonly labelKey: TranslationKey;
}

export interface BotChatMessage {
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly content: string;
  readonly createdAt: string;
  readonly inputId?: string;
  readonly replyTo: readonly string[];
  readonly sources: readonly string[];
  readonly marks: readonly BotChatMark[];
  readonly dispositions: readonly BotDispositionMark[];
  readonly rounds: readonly BotToolRound[];
  readonly meta: BotChatMeta;
  readonly proactive: boolean;
  readonly cards: readonly BotChatCard[];
  readonly quoteRefs: readonly string[];
  readonly separatorLabel: string;
  readonly pending?: 'sending' | 'failed';
}

export interface PendingBotInput {
  readonly inputId: string;
  readonly text: string;
  readonly quoteRefs: readonly string[];
  readonly createdAt: string;
  readonly state: 'sending' | 'failed';
}

export type ConversationRow =
  | { readonly type: 'separator'; readonly id: string; readonly at: string; readonly proactive: boolean; readonly label: string }
  | { readonly type: 'message'; readonly message: BotChatMessage };

const VISIBLE_KINDS = new Set(['user_input', 'agent_reply', 'system_card']);

export function optimisticInputMessageId(inputId: string): string {
  return `input-${inputId}`;
}

export function normalizeBotMessage(raw: Readonly<Record<string, unknown>> | null | undefined): BotChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = readString(raw.id);
  if (!id) return null;
  const explicitKind = readString(raw.kind) || readString(raw.type) || readString(raw.messageKind);
  const role = readString(raw.role);
  const kind = explicitKind || (role === 'user' ? 'user_input' : '');
  const meta = readMeta(raw.meta);
  const replyTo = readStringList(raw.replyTo).length > 0 ? readStringList(raw.replyTo) : (meta.replyTo ?? []);
  const sources = readStringList(raw.sources).length > 0 ? readStringList(raw.sources) : (meta.sources ?? []);
  return {
    id,
    kind,
    role,
    content: readString(raw.content) || readString(raw.text),
    createdAt: readString(raw.createdAt) || readString(raw.at),
    ...(readString(raw.inputId) ? { inputId: readString(raw.inputId) } : {}),
    replyTo,
    sources,
    marks: readMarks(raw.marks),
    dispositions: [],
    rounds: readRounds(raw.rounds),
    meta,
    proactive: raw.proactive === true || meta.surfacing === 'digest',
    cards: readCards(raw.cards),
    quoteRefs: readStringList(raw.quoteRefs),
    separatorLabel: readString(raw.separatorLabel) || meta.separatorLabel || '',
  };
}

/** 只留下用户输入、锚定回复和系统卡片。agent_turn 与其它内部回合丢掉。 */
export function visibleBotMessages(messages: readonly BotChatMessage[]): BotChatMessage[] {
  return messages.filter((message) => VISIBLE_KINDS.has(message.kind));
}

/**
 * 合并一页对话。同一 id 用新页覆盖。
 * 比当前首条更早的新消息插到前面，其余新消息接到后面。
 */
export function mergeConversationPage(
  existing: readonly BotChatMessage[],
  incoming: readonly BotChatMessage[],
): BotChatMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  const order = existing.map((message) => message.id);
  const prepend: string[] = [];
  const append: string[] = [];
  const firstAt = existing[0]?.createdAt ?? '';
  for (const message of incoming) {
    const known = byId.has(message.id);
    byId.set(message.id, known ? { ...byId.get(message.id), ...message, pending: undefined } : message);
    if (known) continue;
    if (existing.length > 0 && message.createdAt && firstAt && message.createdAt < firstAt) prepend.push(message.id);
    else append.push(message.id);
  }
  return [...prepend, ...order, ...append].map((id) => byId.get(id)!);
}

/** 服务端已经有同一 inputId 或 input-<id> 时，拿掉本地的发送中气泡。 */
export function applyOptimistic(
  messages: readonly BotChatMessage[],
  pending: readonly PendingBotInput[],
): BotChatMessage[] {
  const echoed = new Set<string>();
  for (const message of messages) {
    if (message.inputId) echoed.add(message.inputId);
    if (message.id.startsWith('input-')) echoed.add(message.id.slice('input-'.length));
  }
  const extras = pending
    .filter((item) => !echoed.has(item.inputId))
    .map((item): BotChatMessage => ({
      id: optimisticInputMessageId(item.inputId),
      kind: 'user_input',
      role: 'user',
      content: item.text,
      createdAt: item.createdAt,
      inputId: item.inputId,
      replyTo: [],
      sources: [],
      marks: [],
      dispositions: [],
      rounds: [],
      meta: {},
      proactive: false,
      cards: [],
      quoteRefs: item.quoteRefs,
      separatorLabel: '',
      pending: item.state,
    }));
  return [...messages, ...extras];
}

export function repliedUserIds(messages: readonly BotChatMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.kind !== 'agent_reply') continue;
    for (const id of message.replyTo) ids.add(id);
  }
  return ids;
}

const DISPOSITION_LABEL_KEYS: Record<MessageDisposition['kind'], TranslationKey> = {
  answered: 'projectAgent.chat.disposition.answered',
  merged: 'projectAgent.chat.disposition.merged',
  stopped: 'projectAgent.chat.disposition.stopped',
  superseded: 'projectAgent.chat.disposition.superseded',
  parallel: 'projectAgent.chat.disposition.parallel',
  queued: 'projectAgent.chat.disposition.queued',
  out_of_scope: 'projectAgent.chat.disposition.outOfScope',
};

function toolCallsOf(message: BotChatMessage): DispositionToolCall[] {
  const calls: DispositionToolCall[] = [];
  for (const round of message.rounds) {
    for (const call of round.toolCalls) calls.push(call);
  }
  return calls;
}

function sessionIdsOf(item: MessageDisposition, replySources: ReadonlyMap<string, readonly string[]>): string[] {
  switch (item.kind) {
    case 'answered': {
      const ids: string[] = [];
      for (const replyId of item.replyMessageIds) {
        for (const source of replySources.get(replyId) ?? []) {
          if (!ids.includes(source)) ids.push(source);
        }
      }
      return ids;
    }
    case 'merged':
    case 'queued':
    case 'out_of_scope':
      return item.sessionId ? [item.sessionId] : [];
    case 'stopped':
      return [...item.sessionIds];
    case 'superseded':
      return item.newSessionId ? [item.newSessionId] : [];
    case 'parallel':
      return [...item.sessionIds];
    default:
      return [];
  }
}

function sameMark(left: BotDispositionMark, right: BotDispositionMark): boolean {
  return left.kind === right.kind && left.sessionIds.join('\0') === right.sessionIds.join('\0');
}

/**
 * 把本回合工具调用投影成用户气泡上的处置。
 * agent_turn 仍留在输入里，显示时再滤掉。
 * 已经写在消息上的 disposition 字段不采用。
 */
export function applyDispositions(messages: readonly BotChatMessage[]): BotChatMessage[] {
  const events: DispositionEvent[] = [];
  const dispositionMessages: DispositionMessage[] = [];
  const replySources = new Map<string, readonly string[]>();
  let pendingUsers: string[] = [];
  for (const message of messages) {
    if (message.kind === 'user_input') {
      pendingUsers.push(message.id);
      dispositionMessages.push({ id: message.id, role: 'user', replyTo: message.replyTo });
      continue;
    }
    if (message.kind === 'agent_turn') {
      const calls = toolCallsOf(message);
      for (const anchor of pendingUsers) events.push(...dispositionEventsFromToolCalls(anchor, calls));
      pendingUsers = [];
      continue;
    }
    if (message.kind === 'agent_reply') {
      dispositionMessages.push({ id: message.id, role: 'assistant', replyTo: message.replyTo });
      replySources.set(message.id, message.sources);
    }
  }
  const byMessage = new Map<string, BotDispositionMark[]>();
  for (const item of projectMessageDispositions(dispositionMessages, events)) {
    const mark: BotDispositionMark = {
      kind: item.kind,
      sessionIds: sessionIdsOf(item, replySources),
      labelKey: DISPOSITION_LABEL_KEYS[item.kind],
    };
    const list = byMessage.get(item.messageId) ?? [];
    if (!list.some((existing) => sameMark(existing, mark))) list.push(mark);
    byMessage.set(item.messageId, list);
  }
  return messages.map((message) => {
    const dispositions = byMessage.get(message.id);
    if (!dispositions || dispositions.length === 0) return message;
    return { ...message, dispositions };
  });
}

export function conversationRows(messages: readonly BotChatMessage[]): ConversationRow[] {
  const visible = visibleBotMessages(applyDispositions(messages));
  const rows: ConversationRow[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index]!;
    const previous = index > 0 ? visible[index - 1]! : null;
    const separator = separatorFor(previous, message);
    if (separator) rows.push(separator);
    rows.push({ type: 'message', message });
  }
  return rows;
}

export function windowConversationRows<T>(
  rows: readonly T[],
  anchorIndex: number,
  size = 80,
): { start: number; rows: T[] } {
  if (rows.length <= CONVERSATION_WINDOW_THRESHOLD) return { start: 0, rows: [...rows] };
  const span = Math.max(1, size);
  const half = Math.floor(span / 2);
  const index = Math.min(rows.length - 1, Math.max(0, anchorIndex));
  const start = Math.max(0, Math.min(Math.max(0, rows.length - span), index - half));
  return { start, rows: rows.slice(start, start + span) };
}

export function formatConversationStamp(iso: string, now = Date.now()): { sameDay: boolean; clock: string; date: string } | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { sameDay, clock, date: `${date.getMonth() + 1}/${date.getDate()}` };
}

/** 引用记成消息 id 和摘录两段字符串，输入队列只收字符串。 */
export function quoteRefsFor(messageId: string, excerpt: string): string[] {
  const id = messageId.trim();
  const text = excerpt.replace(/\s+/g, ' ').trim();
  if (!id || !text) return [];
  return [id, Array.from(text).slice(0, 240).join('')];
}

export function showAgentThinking(
  pending: readonly PendingBotInput[],
  awaitingReply: boolean,
): boolean {
  if (pending.some((item) => item.state === 'sending' || item.state === 'failed')) return false;
  return awaitingReply;
}

function separatorFor(previous: BotChatMessage | null, message: BotChatMessage): ConversationRow | null {
  const proactive = message.proactive === true;
  const previousAt = previous ? Date.parse(previous.createdAt) : Number.NaN;
  const currentAt = Date.parse(message.createdAt);
  const gap = Number.isFinite(previousAt) && Number.isFinite(currentAt) ? currentAt - previousAt : 0;
  const wide = gap > CONVERSATION_GAP_MS;
  if (!proactive && !wide) return null;
  return {
    type: 'separator',
    id: `sep-${message.id}`,
    at: message.createdAt,
    proactive,
    label: message.separatorLabel,
  };
}

function readMeta(value: unknown): BotChatMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const surfacing = readString(record.surfacing);
  const separatorLabel = readString(record.separatorLabel);
  return {
    replyTo: readStringList(record.replyTo),
    sources: readStringList(record.sources),
    memoryUsed: readStringList(record.memoryUsed),
    memoryLearned: readStringList(record.memoryLearned),
    ...(surfacing ? { surfacing } : {}),
    ...(separatorLabel ? { separatorLabel } : {}),
  };
}

function readMarks(value: unknown): BotChatMark[] {
  if (!Array.isArray(value)) return [];
  const marks: BotChatMark[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const sessionId = readString(record.sessionId);
    const outcome = readString(record.outcome);
    const verdictRef = readString(record.verdictRef);
    if (!sessionId && !outcome) continue;
    marks.push({
      ...(sessionId ? { sessionId } : {}),
      ...(outcome ? { outcome } : {}),
      ...(verdictRef ? { verdictRef } : {}),
    });
  }
  return marks;
}

function readCards(value: unknown): BotChatCard[] {
  if (!Array.isArray(value)) return [];
  const cards: BotChatCard[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const cardId = readString(record.cardId);
    if (!cardId) continue;
    const resolved = record.resolvedState === 'resolved' || record.resolvedState === 'open'
      ? record.resolvedState
      : undefined;
    cards.push({
      cardId,
      kind: readString(record.kind) || 'card',
      content: readString(record.content),
      ...(resolved ? { resolvedState: resolved } : {}),
      actions: readActions(record.actions),
    });
  }
  return cards;
}

function readActions(value: unknown): BotChatCardAction[] {
  if (!Array.isArray(value)) return [];
  const actions: BotChatCardAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = readString(record.id);
    if (!id) continue;
    const channel = readString(record.channel);
    const seam = readString(record.seam);
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : undefined;
    actions.push({
      id,
      ...(channel ? { channel } : {}),
      ...(seam ? { seam } : {}),
      ...(payload ? { payload } : {}),
    });
  }
  return actions;
}

function readRounds(value: unknown): BotToolRound[] {
  if (!Array.isArray(value)) return [];
  const rounds: BotToolRound[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const toolCalls: BotToolCall[] = [];
    if (Array.isArray(record.toolCalls)) {
      for (const call of record.toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const raw = call as Record<string, unknown>;
        const name = readString(raw.name);
        if (!name) continue;
        const input = raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? raw.input as Record<string, unknown>
          : null;
        const result = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
          ? raw.result as Record<string, unknown>
          : null;
        toolCalls.push({ name, input, result });
      }
    }
    rounds.push({ text: readString(record.text), toolCalls });
  }
  return rounds;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
