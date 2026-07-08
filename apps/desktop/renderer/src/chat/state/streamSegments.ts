// 流式内容分段（ContentSegment）的纯逻辑：规范化、签名、重连合并、聚合分组、
// 文本提取、历史内容迁移与「[Tool call:]」序列化文本的反解析。
// 全部为纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 重要边界：parseSerializedToolSegments 解析的是历史消息正文里早期版本写入的
// 「[Tool call:]/[Tool result]」序列化文本，把它还原成结构化 tool-call 段以便正确渲染；
// 这是对既有 user/assistant 文本的事实解析，不是把文本提升为工具执行或系统指令。

import type { ContentSegment, ChatMsg, ToolCallLegacy, SegmentGroup } from './types';

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
    };
  }
  return { type: segment.type, content: segment.content || '' };
}

/** 为一组分段生成完整签名，用于精确判等/前缀匹配。 */
export function segmentsSignature(segments: readonly ContentSegment[]): string {
  return JSON.stringify(segments.map((segment) => {
    if (segment.type === 'tool-call') {
      return [segment.type, segment.toolCallId || '', segment.tool || '', JSON.stringify(segment.args || {}), segment.result || '', segment.synthetic ? '1' : '0'];
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
    const persistedContent = persisted.content || '';
    const liveContent = live.content || '';
    if (liveContent.startsWith(persistedContent)) return { type: 'thinking', content: liveContent };
    if (persistedContent.startsWith(liveContent)) return { type: 'thinking', content: persistedContent };
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

function hoistThinkingWithinTextRuns(groups: SegmentGroup[]): SegmentGroup[] {
  const result: SegmentGroup[] = [];
  let run: SegmentGroup[] = [];

  const flushRun = () => {
    if (!run.length) return;
    const thinkingContent = run
      .filter((group): group is Extract<SegmentGroup, { type: 'thinking' }> => group.type === 'thinking')
      .map((group) => group.content)
      .join('');
    if (thinkingContent) result.push({ type: 'thinking', content: thinkingContent });
    result.push(...run.filter((group) => group.type !== 'thinking'));
    run = [];
  };

  for (const group of groups) {
    if (group.type === 'tool-call-group') {
      flushRun();
      result.push(group);
      continue;
    }
    run.push(group);
  }
  flushRun();
  return result;
}

/** 把扁平分段聚合成渲染分组：tool-call 作为硬边界，thinking 只在同一文本阶段内前置。 */
export function groupSegments(segments: ContentSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      groups.push({ type: 'text', content: seg.content || '' });
    } else if (seg.type === 'thinking') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'thinking') {
        last.content += seg.content || '';
      } else {
        groups.push({ type: 'thinking', content: seg.content || '' });
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

  return hoistThinkingWithinTextRuns(groups);
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
