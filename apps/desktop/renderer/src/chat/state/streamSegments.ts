// 流式内容分段（ContentSegment）的纯逻辑：规范化、签名、重连合并、聚合分组、
// 文本提取、历史内容迁移与「[Tool call:]」序列化文本的反解析。
// 全部为纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 重要边界：parseSerializedToolSegments 解析的是历史消息正文里早期版本写入的
// 「[Tool call:]/[Tool result]」序列化文本，把它还原成结构化 tool-call 段以便正确渲染；
// 这是对既有 user/assistant 文本的事实解析，不是把文本提升为工具执行或系统指令。

import type { ContentSegment, ChatMsg, ToolCallLegacy, SegmentGroup } from './types';
import { readStreamingOpenSlot } from './streamingMarkdownSlot.ts';
import { joinSummaryThinkingContent } from './thinkingSummaryJoin.ts';

type ToolCallSegment = Extract<ContentSegment, { type: 'tool-call' }>;

/** 规范化单个分段：补齐 args/content 默认值，保留结构化字段。 */
export function normalizeStreamSegment(segment: ContentSegment): ContentSegment {
  if (segment.type === 'tool-call') {
    return {
      type: 'tool-call',
      tool: segment.tool,
      displayName: segment.displayName,
      args: segment.args || {},
      result: segment.result,
      synthetic: segment.synthetic,
      toolCallId: segment.toolCallId,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs,
      durationMs: segment.durationMs,
    };
  }
  if (segment.type === 'thinking') {
    return segment.kind
      ? { type: 'thinking', content: segment.content || '', kind: segment.kind }
      : { type: 'thinking', content: segment.content || '' };
  }
  return { type: segment.type, content: segment.content || '' };
}

/** 为一组分段生成完整签名，用于精确判等/前缀匹配。 */
export function segmentsSignature(segments: readonly ContentSegment[]): string {
  return JSON.stringify(segments.map((segment) => {
    if (segment.type === 'tool-call') {
      return [segment.type, segment.toolCallId || '', segment.tool || '', JSON.stringify(segment.args || {}), segment.result || '', segment.synthetic ? '1' : '0', segment.startedAtMs ?? '', segment.endedAtMs ?? '', segment.durationMs ?? ''];
    }
    if (segment.type === 'thinking') {
      return [segment.type, segment.kind || '', segment.content || ''];
    }
    return [segment.type, segment.content || ''];
  }));
}

function stableToolCallId(segment: ContentSegment): string | null {
  if (segment.type !== 'tool-call') return null;
  const id = typeof segment.toolCallId === 'string' ? segment.toolCallId.trim() : '';
  return id || null;
}

function hasArgs(args: Record<string, unknown> | undefined): boolean {
  return Boolean(args && Object.keys(args).length > 0);
}

function mergeSameToolCallSegment(persisted: ToolCallSegment, live: ToolCallSegment): ToolCallSegment {
  const persistedArgs = persisted.args || {};
  const liveArgs = live.args || {};
  return {
    type: 'tool-call',
    tool: live.tool || persisted.tool,
    displayName: live.displayName ?? persisted.displayName,
    args: hasArgs(liveArgs) ? liveArgs : persistedArgs,
    result: live.result !== undefined ? live.result : persisted.result,
    synthetic: live.synthetic ?? persisted.synthetic,
    toolCallId: live.toolCallId || persisted.toolCallId,
  };
}

function settlePersistedToolCalls(
  persisted: readonly ContentSegment[],
  live: readonly ContentSegment[]
): ContentSegment[] {
  const liveByToolCallId = new Map<string, ToolCallSegment>();
  for (const segment of live) {
    const id = stableToolCallId(segment);
    if (id && segment.type === 'tool-call') liveByToolCallId.set(id, segment);
  }
  if (liveByToolCallId.size === 0) return persisted as ContentSegment[];

  let changed = false;
  const next = persisted.map((segment) => {
    const id = stableToolCallId(segment);
    if (!id || segment.type !== 'tool-call') return segment;
    const liveSegment = liveByToolCallId.get(id);
    if (!liveSegment) return segment;
    changed = true;
    return mergeSameToolCallSegment(segment, liveSegment);
  });
  return changed ? next : (persisted as ContentSegment[]);
}

function appendLiveSuffixWithoutDuplicateToolCalls(
  base: readonly ContentSegment[],
  liveSuffix: readonly ContentSegment[]
): ContentSegment[] {
  const seenToolCallIds = new Set<string>();
  for (const segment of base) {
    const id = stableToolCallId(segment);
    if (id) seenToolCallIds.add(id);
  }
  const suffix = liveSuffix.filter((segment) => {
    const id = stableToolCallId(segment);
    return !id || !seenToolCallIds.has(id);
  });
  return [...base, ...suffix];
}

function mergeTextLikeReattachSegment(
  persisted: ContentSegment,
  live: ContentSegment
): ContentSegment | null {
  if (persisted.type === 'text' && live.type === 'text') {
    const persistedContent = persisted.content || '';
    const liveContent = live.content || '';
    if (liveContent.startsWith(persistedContent)) return { type: 'text', content: liveContent };
    if (persistedContent.startsWith(liveContent)) return { type: 'text', content: persistedContent };
  }
  if (persisted.type === 'thinking' && live.type === 'thinking') {
    // Do not reattach-merge across different reasoning kinds.
    if ((persisted.kind || undefined) !== (live.kind || undefined)) return null;
    const persistedContent = persisted.content || '';
    const liveContent = live.content || '';
    const kind = live.kind || persisted.kind;
    if (liveContent.startsWith(persistedContent)) {
      return kind
        ? { type: 'thinking', content: liveContent, kind }
        : { type: 'thinking', content: liveContent };
    }
    if (persistedContent.startsWith(liveContent)) {
      return kind
        ? { type: 'thinking', content: persistedContent, kind }
        : { type: 'thinking', content: persistedContent };
    }
  }
  return null;
}

function mergeReattachPrefixSegment(
  persisted: ContentSegment,
  live: ContentSegment
): ContentSegment | null {
  if (segmentsSignature([persisted]) === segmentsSignature([live])) return persisted;
  return mergeTextLikeReattachSegment(persisted, live);
}

function legacyToolCallFromSegment(seg: ToolCallSegment): ToolCallLegacy {
  const call: ToolCallLegacy = {
    tool: seg.tool!,
    displayName: seg.displayName,
    args: seg.args || {},
    result: seg.result,
    synthetic: seg.synthetic,
  };
  if (seg.toolCallId) call.toolCallId = seg.toolCallId;
  return call;
}

/**
 * 重连（reattach）时合并「已持久化分段」与「main 活跃流快照」。
 * 不变量：绝不删除已经持久化展示过的 UI 证据；当两者分叉时保留可见历史，
 * 仅在可本地证明的最长公共前缀之后追加 live 后缀。同一个 toolCallId 的
 * pending/result 是同一条工具调用的状态推进，必须原地结算，避免重连时出现
 * 「一条一直 loading、一条已完成」的重复工具行。
 *
 * 流式正文/思考在两侧通常都是单个持续增长的 text/thinking 段。若只做整段签名
 * 判等，"已显示前缀" 与 "main 完整快照" 会被误判为分叉，切回会话时拼成
 * "前缀 + 前缀+后续"。因此 text/thinking 段需要额外做内容级前缀合并。
 */
export function mergeReattachedSegments(
  persistedSegments: readonly ContentSegment[] | undefined,
  liveSegments: readonly ContentSegment[] | undefined
): ContentSegment[] {
  const rawPersisted = (persistedSegments || []).map(normalizeStreamSegment);
  const live = (liveSegments || []).map(normalizeStreamSegment);
  if (rawPersisted.length === 0) return live;
  if (live.length === 0) return rawPersisted;
  const persisted = settlePersistedToolCalls(rawPersisted, live);

  // Reattach must never delete already persisted UI evidence.  If main's active-stream
  // snapshot diverges, keep the visible history and append only the live suffix after the
  // longest matching prefix we can prove locally.
  let common = 0;
  const mergedPrefix: ContentSegment[] = [];
  const max = Math.min(persisted.length, live.length);
  while (common < max) {
    const merged = mergeReattachPrefixSegment(persisted[common], live[common]);
    if (!merged) break;
    mergedPrefix.push(merged);
    common += 1;
  }

  if (common === 0) return appendLiveSuffixWithoutDuplicateToolCalls(persisted, live);
  if (common === persisted.length && common === live.length) return mergedPrefix;
  if (common === live.length) return [...mergedPrefix, ...persisted.slice(common)];

  const base = common === persisted.length
    ? mergedPrefix
    : [...mergedPrefix, ...persisted.slice(common)];
  return appendLiveSuffixWithoutDuplicateToolCalls(base, live.slice(common));
}

/** 从分段中提取拼接后的正文文本；为空时返回 fallback。 */
export function contentFromSegments(segments: readonly ContentSegment[], fallback = ''): string {
  const text = segments
    .filter((segment): segment is Extract<ContentSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.content || '')
    .join('');
  return text || fallback;
}

/** 判定是否为「空的 assistant 占位消息」（无正文、无分段）。 */
export function isEmptyAssistantPlaceholder(message: Pick<ChatMsg, 'role' | 'content' | 'segments'>): boolean {
  return (
    message.role === 'assistant' &&
    message.content.trim() === '' &&
    (!Array.isArray(message.segments) || message.segments.length === 0)
  );
}

export const EMPTY_VISIBLE_MODEL_RESPONSE_ERROR =
  'empty_visible_model_response: 模型已结束，但没有返回任何可见文本、思考或工具调用。';

/**
 * 迟到的旧流终态不应改写当前活跃流。
 * Goal 交接后 Runner 会先插入空占位并换上新 streamId；intake 的 done/abort/error
 * 若再落到同一会话，会把新占位误判成「模型空回复」。
 */
export function isStaleStreamTerminal(
  currentStreamId: string | null | undefined,
  eventStreamId: string | null | undefined,
): boolean {
  if (!currentStreamId || !eventStreamId) return false;
  return currentStreamId !== eventStreamId;
}

type AssistantPlaceholderMessage = Pick<ChatMsg, 'role' | 'content' | 'segments'>;

/** 空 assistant 接在已有内容的 assistant 后面：下一 tick 占位，不是本流空回复。 */
export function isSuccessorEmptyAssistantPlaceholder(
  messages: readonly AssistantPlaceholderMessage[] | null | undefined,
): boolean {
  if (!messages || messages.length < 2) return false;
  const last = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  return Boolean(
    last
    && isEmptyAssistantPlaceholder(last)
    && previous.role === 'assistant'
    && !isEmptyAssistantPlaceholder(previous)
  );
}

/**
 * 空占位是否应投影为 empty_visible_model_response。
 * goal_handoff 只是 Goal Runner 本 tick 交接；交接后 Runner 插入的空占位也不是空回复。
 */
export function shouldReportEmptyVisibleModelResponse(options: {
  reason?: string | null;
  lastMessage?: AssistantPlaceholderMessage | null;
  messages?: readonly AssistantPlaceholderMessage[] | null;
}): boolean {
  if (options.reason === 'goal_handoff') return false;
  const messages = options.messages;
  const last = options.lastMessage ?? (messages && messages.length > 0 ? messages[messages.length - 1] : null);
  if (!last || !isEmptyAssistantPlaceholder(last)) return false;
  if (isSuccessorEmptyAssistantPlaceholder(messages ?? (last ? [last] : []))) return false;
  return true;
}

/**
 * 判定是否为「无正文且无附件的空 user 消息」。
 * 这类消息只剩角色标签「你」，是历史残留/竞态产物；图片-only user 不算空。
 */
export function isEmptyUserMessage(
  message: Pick<ChatMsg, 'role' | 'content' | 'attachments'> & { attachments?: readonly unknown[] | null },
): boolean {
  if (message.role !== 'user') return false;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (content.length > 0) return false;
  return !Array.isArray(message.attachments) || message.attachments.length === 0;
}

/** 把扁平分段聚合成渲染分组，严格保留 thinking / text / tool-call 的原始时间顺序。 */
export function groupSegments(segments: ContentSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      const openSlot = readStreamingOpenSlot(seg);
      groups.push(openSlot
        ? { type: 'text', content: seg.content || '', openSlot }
        : { type: 'text', content: seg.content || '' });
    } else if (seg.type === 'thinking') {
      const last = groups[groups.length - 1];
      // Only merge consecutive thinking segments with the same kind (including both
      // missing kind for legacy history). Different kinds stay separate groups so
      // the UI can label summary vs reasoning distinctly.
      const sameKind =
        last
        && last.type === 'thinking'
        && (last.kind || undefined) === (seg.kind || undefined);
      if (sameKind && last.type === 'thinking') {
        // Summary tracks re-join with the same safe phrase helper; other kinds stay plain +.
        last.content =
          last.kind === 'summary'
            ? joinSummaryThinkingContent(last.content || '', seg.content || '')
            : last.content + (seg.content || '');
      } else {
        groups.push(
          seg.kind
            ? { type: 'thinking', content: seg.content || '', kind: seg.kind }
            : { type: 'thinking', content: seg.content || '' },
        );
      }
    } else {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tool-call-group') {
        last.calls.push(legacyToolCallFromSegment(seg));
      } else {
        groups.push({ type: 'tool-call-group', calls: [legacyToolCallFromSegment(seg)] });
      }
    }
  }

  return groups;
}

export type SplitFinalTextOptions = {
  /**
   * 有未完成交互卡时：该轮所有非空 text 都留在折叠区外。
   * 避免「选项在外、决策上下文被折进『已处理』」导致用户看不懂选项。
   * thinking / tool-call 仍进历史折叠区。
   */
  readonly keepAllTextOutside?: boolean;
};

/**
 * 把已完成回复拆成「历史过程 + 折叠区外正文」。
 *
 * 默认：取时间线中最后一段非空 text 外露（即使其后还有 tool-call / thinking）；
 * 其余组严格保持原顺序进入历史区。这样 text → goal_create_plan 这类「说明后接工具」
 * 的回合，说明正文不会被自动折叠进「已处理」后看起来像消失。
 * 若没有任何非空 text，则全部进历史区。
 * keepAllTextOutside=true：所有非空 text 都外露；历史区只保留 thinking / tool-call（过程噪音）。
 */
export function splitFinalTextGroup(
  groups: SegmentGroup[],
  options?: SplitFinalTextOptions,
): {
  historyGroups: SegmentGroup[];
  finalTextGroups: Array<Extract<SegmentGroup, { type: 'text' }>>;
} {
  if (options?.keepAllTextOutside) {
    const finalTextGroups = groups.filter(
      (group): group is Extract<SegmentGroup, { type: 'text' }> =>
        group.type === 'text' && Boolean(group.content.trim()),
    );
    return {
      historyGroups: groups.filter((group) => group.type !== 'text'),
      finalTextGroups,
    };
  }

  let lastTextIndex = -1;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group?.type === 'text' && group.content.trim()) {
      lastTextIndex = i;
      break;
    }
  }
  if (lastTextIndex < 0) {
    return { historyGroups: groups, finalTextGroups: [] };
  }

  const finalText = groups[lastTextIndex] as Extract<SegmentGroup, { type: 'text' }>;
  return {
    historyGroups: [
      ...groups.slice(0, lastTextIndex),
      ...groups.slice(lastTextIndex + 1),
    ],
    finalTextGroups: [finalText],
  };
}

/** 仅提取 text 分段并拼接（不含 fallback 语义）。 */
export function getTextContent(segments: ContentSegment[]): string {
  return segments.filter((s) => s.type === 'text').map((s) => s.content || '').join('');
}

/** 把旧版「正文 + toolCalls」结构迁移成统一的分段数组。 */
export function migrateToSegments(content: string, toolCalls?: ToolCallLegacy[]): ContentSegment[] | undefined {
  if (!toolCalls?.length && !content) return undefined;
  const segs: ContentSegment[] = [];
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      const segment: Extract<ContentSegment, { type: 'tool-call' }> = {
        type: 'tool-call',
        tool: tc.tool,
        displayName: tc.displayName,
        args: tc.args,
        result: tc.result,
      };
      if (tc.toolCallId) segment.toolCallId = tc.toolCallId;
      segs.push(segment);
    }
  }
  if (content) segs.push({ type: 'text', content });
  return segs.length ? segs : undefined;
}

/** 定位下一处序列化「[Tool call:]」标记的起点（供 parse 使用）。 */
export function findNextSerializedToolCall(content: string, fromIndex: number): number {
  const match = content.slice(fromIndex).match(/\n\[Tool call:/);
  return match?.index === undefined ? content.length : fromIndex + match.index + 1;
}

/**
 * 反解析历史正文里早期版本写入的「[Tool call: <tool> <argsJson>] / [Tool result]」
 * 序列化文本，还原成结构化 tool-call 段；若正文不含此类标记则返回 undefined。
 */
export function parseSerializedToolSegments(content: string): ContentSegment[] | undefined {
  if (!content.includes('[Tool call:')) return undefined;

  const segments: ContentSegment[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('[Tool call:', cursor);
    if (start < 0) {
      const tail = content.slice(cursor);
      if (tail) segments.push({ type: 'text', content: tail });
      break;
    }

    const before = content.slice(cursor, start);
    if (before) segments.push({ type: 'text', content: before });

    const headerEnd = content.indexOf('\n', start);
    if (headerEnd < 0) {
      segments.push({ type: 'text', content: content.slice(start) });
      break;
    }

    const header = content.slice(start, headerEnd).trim();
    const headerMatch = header.match(/^\[Tool call:\s+(\S+)\s+(.+)\]$/);
    const resultMarker = '\n[Tool result]\n';
    const resultMarkerIndex = content.indexOf(resultMarker, headerEnd);
    if (!headerMatch) {
      segments.push({ type: 'text', content: content.slice(start) });
      break;
    }

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(headerMatch[2]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = { raw: headerMatch[2] };
    }

    if (resultMarkerIndex < 0) {
      segments.push({
        type: 'tool-call',
        tool: headerMatch[1],
        args,
        result: undefined,
        synthetic: true,
      });
      const rest = content.slice(headerEnd).trim();
      if (rest) segments.push({ type: 'text', content: rest });
      break;
    }

    const resultStart = resultMarkerIndex + resultMarker.length;
    const nextStart = findNextSerializedToolCall(content, resultStart);
    segments.push({
      type: 'tool-call',
      tool: headerMatch[1],
      args,
      result: content.slice(resultStart, nextStart).trim(),
    });
    cursor = nextStart;
  }

  return segments.some((segment) => segment.type === 'tool-call') ? segments : undefined;
}

/**
 * 终态兜底：把「已发出但未回填结果」的 tool-call 段标记为中断。
 *
 * 背景：tool-call 段在渲染层以 `result === undefined && !synthetic` 表达「执行中」
 * （永久转圈）。当一轮在 done/error/aborted 终态结束时，若某个 tool-call 段始终没有
 * 等到 tool-result（例如连接中断、被取消、后端未回传结果），该段会卡在转圈态。
 * 本函数为这些残留段补写一个明确的「已中断」result 文本，使其脱离转圈态并向用户
 * 说明原因。这是对既有视图模型的事实兜底，不声称工具已成功执行。
 *
 * 纯函数：当没有任何需要兜底的段时返回原数组引用（便于调用方据此跳过 setState）。
 *
 * @param segments 待处理的分段数组
 * @param note 写入残留段 result 的中断说明文本
 */
export function markDanglingToolCallsInterrupted(
  segments: readonly ContentSegment[] | undefined,
  note: string
): ContentSegment[] {
  const list = segments || [];
  let changed = false;
  const next = list.map((segment) => {
    if (segment.type === 'tool-call' && segment.result === undefined && segment.synthetic !== true) {
      changed = true;
      return { ...segment, result: note };
    }
    return segment;
  });
  return changed ? next : (list as ContentSegment[]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * 把 Rust 原生运行时落盘的结构化 tool-call result 对象规整为 Desktop 可直接渲染的字符串。
 * - `undefined` / `null` 保留为 `undefined`（代表工具仍在执行中，展示转圈态）。
 * - `error` 对象规整为 `[code] message`。
 * - `output.lanes`（batch_search）保持 JSON 字符串，供 BatchSearchToolCard 还原分路检索视图。
 * - 其余对象优先提取 preview / content / stdout+stderr，缺省序列化为缩进 JSON，避免 React 直接渲染对象崩溃。
 */
export function normalizeToolCallResultForDesktop(rawResult: unknown): string | undefined {
  if (rawResult === undefined || rawResult === null) return undefined;
  if (typeof rawResult === 'string') return rawResult;
  if (!isPlainObject(rawResult)) return String(rawResult);

  if (isPlainObject(rawResult.error)) {
    const code = typeof rawResult.error.code === 'string' ? rawResult.error.code.trim() : '';
    const message = typeof rawResult.error.message === 'string' ? rawResult.error.message.trim() : '';
    if (message) return code ? `[${code}] ${message}` : message;
    if (code) return code;
  } else if (typeof rawResult.error === 'string' && rawResult.error.trim()) {
    return rawResult.error.trim();
  }

  const output = rawResult.output;
  if (typeof output === 'string') return output;
  if (isPlainObject(output)) {
    if (Array.isArray(output.lanes)) {
      return JSON.stringify(output, null, 2);
    }
    if (output.kind === 'text' && typeof output.preview === 'string') {
      return output.preview;
    }
    if (typeof output.content === 'string' && output.content.trim()) {
      return output.content;
    }
    const stdout = typeof output.stdout === 'string' ? output.stdout : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr : '';
    if (stdout || stderr) {
      return [stdout, stderr].filter(Boolean).join('\n');
    }
    if (Object.keys(output).length > 0) {
      return JSON.stringify(output, null, 2);
    }
  }

  if (typeof rawResult.detail === 'string' && rawResult.detail.trim()) {
    return rawResult.detail;
  }
  if (isPlainObject(rawResult.outputPreview) && typeof rawResult.outputPreview.preview === 'string') {
    return rawResult.outputPreview.preview;
  }
  return JSON.stringify(rawResult, null, 2);
}

function normalizeRawSegmentForDesktop(rawSeg: unknown): Record<string, unknown> | null {
  if (!isPlainObject(rawSeg) || typeof rawSeg.type !== 'string') return null;
  if (rawSeg.type !== 'tool-call') {
    return { ...rawSeg };
  }
  const normalizedResult = normalizeToolCallResultForDesktop(rawSeg.result);
  const startedAtMs = typeof rawSeg.startedAtMs === 'number' && Number.isFinite(rawSeg.startedAtMs)
    ? rawSeg.startedAtMs
    : undefined;
  let endedAtMs = typeof rawSeg.endedAtMs === 'number' && Number.isFinite(rawSeg.endedAtMs)
    ? rawSeg.endedAtMs
    : undefined;
  if (endedAtMs === undefined && isPlainObject(rawSeg.result) && typeof rawSeg.result.completedAt === 'string') {
    const parsed = Date.parse(rawSeg.result.completedAt);
    if (Number.isFinite(parsed)) endedAtMs = parsed;
  }
  let durationMs = typeof rawSeg.durationMs === 'number' && Number.isFinite(rawSeg.durationMs)
    ? rawSeg.durationMs
    : undefined;
  if (durationMs === undefined && startedAtMs !== undefined && endedAtMs !== undefined && endedAtMs >= startedAtMs) {
    durationMs = endedAtMs - startedAtMs;
  }
  const next: Record<string, unknown> = {
    ...rawSeg,
    args: isPlainObject(rawSeg.args) ? rawSeg.args : {},
  };
  if (normalizedResult !== undefined) {
    next.result = normalizedResult;
  } else {
    delete next.result;
  }
  if (startedAtMs !== undefined) next.startedAtMs = startedAtMs;
  if (endedAtMs !== undefined) next.endedAtMs = endedAtMs;
  if (durationMs !== undefined) next.durationMs = durationMs;
  return next;
}

function extractRawAssistantSegments(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    const normalized: Record<string, unknown>[] = [];
    for (const seg of raw.segments) {
      const item = normalizeRawSegmentForDesktop(seg);
      if (item) normalized.push(item);
    }
    return normalized;
  }
  const out: Record<string, unknown>[] = [];
  if (typeof raw.thinkingContent === 'string' && raw.thinkingContent.trim()) {
    out.push({ type: 'thinking', content: raw.thinkingContent });
  }
  if (Array.isArray(raw.toolCalls) && raw.toolCalls.length > 0) {
    const migrated = migrateToSegments(
      typeof raw.content === 'string' ? raw.content : '',
      raw.toolCalls as ToolCallLegacy[],
    );
    if (migrated) {
      for (const seg of migrated) {
        const item = normalizeRawSegmentForDesktop(seg);
        if (item) out.push(item);
      }
      return out;
    }
  }
  if (typeof raw.content === 'string' && raw.content.trim()) {
    const parsed = parseSerializedToolSegments(raw.content);
    if (parsed && parsed.length > 0) {
      for (const seg of parsed) {
        const item = normalizeRawSegmentForDesktop(seg);
        if (item) out.push(item);
      }
    } else {
      out.push({ type: 'text', content: raw.content });
    }
  }
  return out;
}

function appendOrMergeRawSegment(
  targetSegments: Record<string, unknown>[],
  segment: Record<string, unknown>,
): void {
  const callId = segment.type === 'tool-call' && typeof segment.toolCallId === 'string'
    ? segment.toolCallId.trim()
    : '';
  if (callId) {
    for (let i = targetSegments.length - 1; i >= 0; i -= 1) {
      const existing = targetSegments[i];
      if (existing && existing.type === 'tool-call' && existing.toolCallId === callId) {
        const mergedArgs = isPlainObject(segment.args) && Object.keys(segment.args).length > 0
          ? segment.args
          : existing.args;
        targetSegments[i] = {
          ...existing,
          ...segment,
          ...(mergedArgs ? { args: mergedArgs } : {}),
          result: segment.result !== undefined ? segment.result : existing.result,
        };
        return;
      }
    }
  }
  targetSegments.push(segment);
}

function isFoldableAssistantStreamRow(raw: Record<string, unknown>): boolean {
  if (String(raw.role ?? '') !== 'assistant') return false;
  if (raw._compaction && typeof raw._compaction === 'object') return false;
  if (typeof raw.kind === 'string' && raw.kind !== 'assistant' && raw.kind !== '') return false;
  return typeof raw.streamId === 'string' && raw.streamId.trim().length > 0;
}

/**
 * 兼容 CLI/TUI 与 Rust 原生委派会话的多行落盘形态：
 * 1. 把 `role=tool` 消息折叠进前一条 `assistant` 的 `tool-call` segments；
 * 2. 把共享同一 `streamId` 的连续 `role=assistant` 行（每步思考/工具/文本各自落盘）
 *    按原始时间顺序合并回单条 `assistant` 消息，恢复 Desktop 0.18.0 的单轮统一过程渲染；
 * 3. 把 Rust 落盘的结构化 `tool-call.result` 对象规整为安全可展示字符串。
 * 这是历史回放适配，不改变持久化真值，也不把工具文本提升为可执行指令。
 */
export function foldCliToolMessagesForDesktop(
  rawMessages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of rawMessages) {
    const role = String(raw.role ?? '');
    if (role === 'assistant') {
      const normalizedRow: Record<string, unknown> = { ...raw };
      if (Array.isArray(raw.segments) && raw.segments.length > 0) {
        normalizedRow.segments = raw.segments
          .map((seg) => normalizeRawSegmentForDesktop(seg))
          .filter((seg): seg is Record<string, unknown> => seg !== null);
      }

      const prev = out[out.length - 1];
      if (
        prev
        && isFoldableAssistantStreamRow(prev)
        && isFoldableAssistantStreamRow(normalizedRow)
        && String(prev.streamId).trim() === String(normalizedRow.streamId).trim()
      ) {
        const mergedTarget: Record<string, unknown> = { ...prev };
        const mergedSegments = extractRawAssistantSegments(prev);
        for (const seg of extractRawAssistantSegments(normalizedRow)) {
          appendOrMergeRawSegment(mergedSegments, seg);
        }
        mergedTarget.segments = mergedSegments;
        if (typeof normalizedRow.content === 'string' && normalizedRow.content.trim()) {
          mergedTarget.content = normalizedRow.content;
        }
        if (normalizedRow.interrupted === true) {
          mergedTarget.interrupted = true;
          if (normalizedRow.streamFailure !== undefined) {
            mergedTarget.streamFailure = normalizedRow.streamFailure;
          }
        }
        if (typeof normalizedRow.durationMs === 'number' && Number.isFinite(normalizedRow.durationMs)) {
          mergedTarget.durationMs = normalizedRow.durationMs;
        }
        if (isPlainObject(normalizedRow.usage)) {
          if (isPlainObject(mergedTarget.usage)) {
            const pu = mergedTarget.usage;
            const nu = normalizedRow.usage;
            mergedTarget.usage = {
              input: (Number(pu.input) || 0) + (Number(nu.input) || 0),
              output: (Number(pu.output) || 0) + (Number(nu.output) || 0),
              cacheWrite: (Number(pu.cacheWrite) || 0) + (Number(nu.cacheWrite) || 0),
              cacheRead: (Number(pu.cacheRead) || 0) + (Number(nu.cacheRead) || 0),
            };
          } else {
            mergedTarget.usage = normalizedRow.usage;
          }
        }
        out[out.length - 1] = mergedTarget;
        continue;
      }

      out.push(normalizedRow);
      continue;
    }

    if (role !== 'tool') {
      out.push({ ...raw });
      continue;
    }

    const content = typeof raw.content === 'string' ? raw.content : '';
    const tool = raw.tool && typeof raw.tool === 'object' && !Array.isArray(raw.tool)
      ? raw.tool as Record<string, unknown>
      : null;
    const existingSegments = Array.isArray(raw.segments)
      ? raw.segments as Record<string, unknown>[]
      : [];
    const segmentFromTool = tool && typeof tool.capabilityId === 'string'
      ? {
          type: 'tool-call',
          tool: tool.capabilityId,
          displayName: typeof tool.toolName === 'string' ? tool.toolName : tool.capabilityId,
          ...(tool.arguments && typeof tool.arguments === 'object' && !Array.isArray(tool.arguments)
            ? { args: tool.arguments as Record<string, unknown> }
            : {}),
          result: typeof tool.detail === 'string' && tool.detail.trim()
            ? tool.detail
            : (content || String(tool.status ?? 'completed')),
          ...(typeof tool.toolCallId === 'string' && tool.toolCallId.trim()
            ? { toolCallId: tool.toolCallId }
            : {}),
        }
      : normalizeRawSegmentForDesktop(
          existingSegments.find((segment) => segment?.type === 'tool-call'),
        )
        ?? {
          type: 'tool-call',
          tool: 'tool',
          result: content || 'completed',
        };

    let targetIndex = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (String(out[i]?.role) === 'assistant') {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) {
      out.push({
        id: typeof raw.id === 'string' ? raw.id : `tool-folded-${out.length + 1}`,
        role: 'assistant',
        content: '',
        segments: [segmentFromTool],
        timestamp: raw.timestamp,
      });
      continue;
    }

    const target = { ...out[targetIndex] } as Record<string, unknown>;
    const prevSegments = extractRawAssistantSegments(target);
    appendOrMergeRawSegment(prevSegments, segmentFromTool);
    target.segments = prevSegments;
    out[targetIndex] = target;
  }
  return out;
}


