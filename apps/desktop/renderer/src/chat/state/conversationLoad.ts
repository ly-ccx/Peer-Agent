// 会话消息加载与用量映射的共享纯逻辑（从 ChatSurface 抽出）。
//
// 背景：会话内容的加载（conversationsGet → ChatMsg[]）、整轮用量归一（usageFromLifetime）
// 与消息 id 生成（nextId）原先都内联在 ChatSurface 里。当流订阅上移为应用级单例后
// （conversationStreamRouter），路由器在压缩完成、终结收尾等路径也需要重新加载会话，
// 因此把这三段「无 React 依赖」的纯逻辑下沉为共享模块，供 ChatSurface 与路由器复用，
// 杜绝两份实现漂移。
//
// 行为零变更：以下三个导出与原 ChatSurface 内的同名实现逐字一致，仅改为相对路径导入。
// 发送/账本真值仍在主进程，这里只负责把主进程返回的会话数据映射为表达层 ChatMsg。

import { clientApi } from '../../clientApi';
import { normalizeChatMode, type ChatMode } from './preferences';
import {
  isEmptyAssistantPlaceholder,
  migrateToSegments,
  parseSerializedToolSegments,
} from './streamSegments';
import type {
  ChatAttachment,
  ChatMsg,
  CompactionMeta,
  ContentSegment,
  ToolCallLegacy,
} from './types';

let msgSeq = 0;
/** 生成表达层消息的本地临时 id（持久化真值由主进程负责）。 */
export function nextId(): string {
  return `msg-${++msgSeq}-${Date.now()}`;
}

/** 把主进程的 lifetimeUsage（驼峰）映射为表达层 TokenUsageState 字段。 */
export function usageFromLifetime(lifetime: {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  return {
    input: lifetime.inputTokens ?? 0,
    output: lifetime.outputTokens ?? 0,
    cacheWrite: lifetime.cacheWriteTokens ?? 0,
    cacheRead: lifetime.cacheReadTokens ?? 0,
  };
}

/**
 * 加载某会话的消息与整轮用量、对话模式。
 *
 * - 兼容老会话的多种段落形态（segments / toolCalls / 序列化工具段）。
 * - 计费优先读 index meta 的权威累计 lifetimeUsage（不受压缩影响）；老会话无该字段时
 *   才回退到遍历消息累加（此路径会被压缩低估，属兼容降级）。
 * - 剥离空 assistant 占位（isEmptyAssistantPlaceholder），避免历史里残留空泡。
 */
export async function loadConversationMessages(conversationId: string): Promise<{
  messages: ChatMsg[];
  tokenUsage: { input: number; output: number; cacheWrite: number; cacheRead: number } | null;
  mode: ChatMode;
}> {
  const conv = await clientApi.conversationsGet({ id: conversationId });
  if (!conv?.messages) return { messages: [], tokenUsage: null, mode: 'chat' };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'，历史 'goal' 归一化为 'plan'。
  const convMode: ChatMode = normalizeChatMode(conv.mode);
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const loaded = conv.messages.map((m: Record<string, unknown>) => {
    const msg: ChatMsg = {
      id: (m.id as string) || nextId(),
      role: (m.role as ChatMsg['role']) || 'user',
      content: (m.content as string) || '',
      timestamp: m.timestamp as number | undefined,
    };
    if (m.segments) {
      msg.segments = m.segments as ContentSegment[];
    } else if (Array.isArray(m.toolCalls) && (m.toolCalls as unknown[]).length) {
      msg.segments = migrateToSegments(msg.content, m.toolCalls as ToolCallLegacy[]);
    } else if (msg.role === 'assistant') {
      msg.segments = parseSerializedToolSegments(msg.content);
    }
    if (m.usage && typeof m.usage === 'object') {
      const u = m.usage as { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
      msg.usage = { input: u.input ?? 0, output: u.output ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheRead: u.cacheRead ?? 0 };
      totalInput += msg.usage.input;
      totalOutput += msg.usage.output;
      totalCacheWrite += msg.usage.cacheWrite ?? 0;
      totalCacheRead += msg.usage.cacheRead ?? 0;
    }
    if (m._compaction && typeof m._compaction === 'object') {
      const c = m._compaction as unknown as CompactionMeta;
      msg.compaction = c;
    }
    if (Array.isArray(m.attachments)) {
      msg.attachments = m.attachments as ChatAttachment[];
    }
    // ADR 33: 每条消息的整轮工作时长留痕,随消息持久化,重启后仍可见。
    if (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs)) {
      msg.durationMs = m.durationMs;
    }
    // (b) 长流中断保留：连接中断未自然收尾的 assistant 消息标记，重启后仍可见。
    if (m.interrupted === true) {
      msg.interrupted = true;
    }
    return msg;
  }).filter((message) => !isEmptyAssistantPlaceholder(message));
  // ADR 23: 计费优先读 index meta 的权威累计 lifetimeUsage(不受压缩影响)。
  // 仅当老会话尚无该字段时,才回退到遍历消息累加(此路径会被压缩低估,属兼容降级)。
  const lifetime = conv.lifetimeUsage as
    | { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number }
    | undefined;
  if (
    lifetime &&
    ((lifetime.inputTokens ?? 0) > 0 ||
      (lifetime.outputTokens ?? 0) > 0 ||
      (lifetime.cacheWriteTokens ?? 0) > 0 ||
      (lifetime.cacheReadTokens ?? 0) > 0)
  ) {
    return {
      messages: loaded,
      tokenUsage: usageFromLifetime(lifetime),
      mode: convMode,
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
    mode: convMode,
  };
}
