import type { AutomationCreateContext, ContextAccountingSnapshot } from "@peer-agent/protocol";
import { clientApi } from "../../clientApi";
import { isEffortLevel, normalizeChatMode, type EffortLevel, type ChatMode } from "./preferences";
import {
  foldCliToolMessagesForDesktop,
  isEmptyAssistantPlaceholder,
  isEmptyUserMessage,
  migrateToSegments,
  parseSerializedToolSegments,
} from "./streamSegments";
import type { ChatAttachment, ContentSegment, ToolCallLegacy, CompactionMeta, ChatMsg } from "./types";
import { mapInChunks } from "./yieldToMain";

let msgSeq = 0;

export { shouldLoadOlderHistory } from "./conversationWindowPolicy";

export function nextId() { return `msg-${++msgSeq}-${Date.now()}`; }

function usageFromLifetime(lifetime: {
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

export async function loadConversationMessages(conversationId: string, options?: {
  readonly before?: string | null;
}): Promise<{
  messages: ChatMsg[];
  tokenUsage: { input: number; output: number; cacheWrite: number; cacheRead: number } | null;
  mode: ChatMode;
  fastMode: boolean;
  preferredExecutionIsolation: 'none' | 'worktree';
  effort: EffortLevel;
  modelProviderId: string | null;
  contextAccounting: ContextAccountingSnapshot | null;
  automationCreateContext: AutomationCreateContext | null;
  cursor: string | null;
  hasMore: boolean;
}> {
  let page = await clientApi.conversationsGet({
    id: conversationId,
    ...(options?.before ? { before: options.before } : {}),
  });
  // Rust 原生委派会话按单步落盘（同一 streamId 可超过默认 80 行窗口）；
  // 若首页被截断在单个流中间，按上限窗口 200 补拉一次（不突破分页上限），避免把单轮执行过程腰斩。
  if (
    page
    && page.hasMore === true
    && !options?.before
    && Array.isArray(page.window)
    && page.window.length > 0
  ) {
    const firstRow = page.window[0] as Record<string, unknown> | undefined;
    const firstStreamId = typeof firstRow?.streamId === 'string' ? firstRow.streamId.trim() : '';
    if (firstRow?.role === 'assistant' && firstStreamId) {
      const widerPage = await clientApi.conversationsGet({ id: conversationId, limit: 200 });
      if (widerPage?.meta) page = widerPage;
    }
  }
  const rows = foldCliToolMessagesForDesktop((page?.window ?? []) as readonly Record<string, unknown>[]);
  const meta = page?.meta;
  if (!page || !meta) return {
    messages: [],
    tokenUsage: null,
    mode: 'chat',
    fastMode: false,
    preferredExecutionIsolation: 'none',
    effort: 'default',
    modelProviderId: null,
    contextAccounting: null,
    automationCreateContext: null,
    cursor: null,
    hasMore: false,
  };
  // 对话模式按会话持久化在会话 meta 上;老会话无该字段时回退 'chat'，历史 'goal' 归一化为 'plan'。
  const convMode: ChatMode = normalizeChatMode(meta.mode);
  const convFastMode = meta.fastMode === true;
  const convPreferredExecutionIsolation: 'none' | 'worktree' =
    meta.preferredExecutionIsolation === 'worktree' ? 'worktree' : 'none';
  // 思考强度 + 模型 provider 也按会话持久化在会话 meta 上（与 mode 同口径，每会话独立）。
  // 老会话无字段时：effort 回退 'default'，modelProviderId 回退 null（用全局默认 provider）。
  const convEffort: EffortLevel = isEffortLevel(meta.effort) ? meta.effort : 'default';
  const convModelProviderId: string | null =
    typeof meta.modelProviderId === 'string' && meta.modelProviderId ? meta.modelProviderId : null;
  const contextAccounting: ContextAccountingSnapshot | null =
    meta.contextSnapshot?.version === 1 ? meta.contextSnapshot : null;
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const mapped = await mapInChunks(
    rows,
    (m) => {
    const roleRaw = String(m.role ?? 'user');
    const role: ChatMsg['role'] = roleRaw === 'assistant' || roleRaw === 'system'
      ? roleRaw
      : roleRaw === 'tool'
        ? 'assistant'
        : 'user';
    const rawTs = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
      ? m.timestamp
      : typeof m.createdAt === 'string'
        ? Date.parse(m.createdAt)
        : NaN;
    const msg: ChatMsg = {
      id: (m.id as string) || nextId(),
      role,
      content: (m.content as string) || '',
      timestamp: Number.isFinite(rawTs) ? rawTs : undefined,
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
  },
    { chunkSize: 32 },
  );
  const loaded = mapped.filter((message) => !isEmptyAssistantPlaceholder(message) && !isEmptyUserMessage(message));
  // ADR 23: 计费优先读 index meta 的权威累计 lifetimeUsage(不受压缩影响)。
  // 仅当老会话尚无该字段时,才回退到遍历消息累加(此路径会被压缩低估,属兼容降级)。
  const lifetime = meta.lifetimeUsage as
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
      fastMode: convFastMode,
      preferredExecutionIsolation: convPreferredExecutionIsolation,
      effort: convEffort,
      modelProviderId: convModelProviderId,
      contextAccounting,
      automationCreateContext: meta.automationCreateContext ?? null,
      cursor: page.cursor ?? null,
      hasMore: page.hasMore === true,
    };
  }
  return {
    messages: loaded,
    tokenUsage: totalInput > 0 || totalOutput > 0 || totalCacheWrite > 0 || totalCacheRead > 0
      ? { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead }
      : null,
    mode: convMode,
    fastMode: convFastMode,
    preferredExecutionIsolation: convPreferredExecutionIsolation,
    effort: convEffort,
    modelProviderId: convModelProviderId,
    contextAccounting,
    automationCreateContext: meta.automationCreateContext ?? null,
    cursor: page.cursor ?? null,
    hasMore: page.hasMore === true,
  };
}
