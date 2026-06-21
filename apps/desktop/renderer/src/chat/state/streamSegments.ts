// 流式内容分段（ContentSegment）的纯逻辑：规范化、签名、重连合并、聚合分组、
// 文本提取、历史内容迁移与「[Tool call:]」序列化文本的反解析。
// 全部为纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 重要边界：parseSerializedToolSegments 解析的是历史消息正文里早期版本写入的
// 「[Tool call:]/[Tool result]」序列化文本，把它还原成结构化 tool-call 段以便正确渲染；
// 这是对既有 user/assistant 文本的事实解析，不是把文本提升为工具执行或系统指令。

import type { ContentSegment, ChatMsg, ToolCallLegacy, SegmentGroup } from './types';

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

/** 为一组分段生成稳定签名，用于判等/前缀匹配（不含易变字段）。 */
export function segmentsSignature(segments: readonly ContentSegment[]): string {
  return JSON.stringify(segments.map((segment) => {
    if (segment.type === 'tool-call') {
      return [segment.type, segment.toolCallId || '', segment.tool || '', JSON.stringify(segment.args || {}), segment.result || '', segment.synthetic ? '1' : '0'];
    }
    return [segment.type, segment.content || ''];
  }));
}

/**
 * 重连（reattach）时合并「已持久化分段」与「main 活跃流快照」。
 * 不变量：绝不删除已经持久化展示过的 UI 证据；当两者分叉时保留可见历史，
 * 仅在可本地证明的最长公共前缀之后追加 live 后缀。
 */
export function mergeReattachedSegments(
  persistedSegments: readonly ContentSegment[] | undefined,
  liveSegments: readonly ContentSegment[] | undefined
): ContentSegment[] {
  const persisted = (persistedSegments || []).map(normalizeStreamSegment);
  const live = (liveSegments || []).map(normalizeStreamSegment);
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const persistedSignature = segmentsSignature(persisted);
  const liveSignature = segmentsSignature(live);
  if (liveSignature === persistedSignature) return persisted;
  if (live.length >= persisted.length && segmentsSignature(live.slice(0, persisted.length)) === persistedSignature) {
    return live;
  }
  if (persisted.length > live.length && segmentsSignature(persisted.slice(0, live.length)) === liveSignature) {
    return persisted;
  }

  // Reattach must never delete already persisted UI evidence.  If main's active-stream
  // snapshot diverges, keep the visible history and append only the live suffix after the
  // longest matching prefix we can prove locally.
  let common = 0;
  const max = Math.min(persisted.length, live.length);
  while (common < max && segmentsSignature([persisted[common]]) === segmentsSignature([live[common]])) common += 1;
  return [...persisted, ...live.slice(common)];
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

/** 把扁平分段聚合成渲染分组：连续 thinking 合并、连续 tool-call 归入同一组。 */
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
        last.calls.push({ tool: seg.tool!, displayName: seg.displayName, args: seg.args || {}, result: seg.result, synthetic: seg.synthetic });
      } else {
        groups.push({ type: 'tool-call-group', calls: [{ tool: seg.tool!, displayName: seg.displayName, args: seg.args || {}, result: seg.result, synthetic: seg.synthetic }] });
      }
    }
  }
  return groups;
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
      segs.push({ type: 'tool-call', tool: tc.tool, displayName: tc.displayName, args: tc.args, result: tc.result });
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
