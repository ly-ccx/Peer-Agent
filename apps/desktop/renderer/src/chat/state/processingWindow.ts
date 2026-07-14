import type { SegmentGroup, ToolCallGroup } from './types';

export const DEFAULT_PROCESSING_EVENT_LIMIT = 60;
export const DEFAULT_PROCESSING_TEXT_LIMIT = 8_000;
export const DEFAULT_INLINE_PREVIEW_LIMIT = 240;

export interface ProcessingWindow {
  readonly groups: SegmentGroup[];
  readonly omittedCount: number;
}

export interface TextWindow {
  readonly content: string;
  readonly omittedCharacterCount: number;
}

function normalizeTextLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

/** 保留单条超长思考事件的最新文本，避免默认挂载并解析整段历史 Markdown。 */
export function windowProcessingText(
  content: string,
  limit: number = DEFAULT_PROCESSING_TEXT_LIMIT,
): TextWindow {
  const safeLimit = normalizeTextLimit(limit);
  if (content.length <= safeLimit) {
    return { content, omittedCharacterCount: 0 };
  }
  if (safeLimit === 0) {
    return { content: '', omittedCharacterCount: content.length };
  }

  let start = content.length - safeLimit;
  const codeUnit = content.charCodeAt(start);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) start += 1;
  return {
    content: content.slice(start),
    omittedCharacterCount: start,
  };
}

/** 把常驻单行标题压到固定长度；完整内容仍由展开态按需挂载。 */
export function previewInlineText(
  content: string,
  limit: number = DEFAULT_INLINE_PREVIEW_LIMIT,
): TextWindow {
  const normalized = content.trim().replace(/\s+/g, ' ');
  const safeLimit = normalizeTextLimit(limit);
  if (normalized.length <= safeLimit) {
    return { content: normalized, omittedCharacterCount: 0 };
  }
  if (safeLimit === 0) {
    return { content: '', omittedCharacterCount: normalized.length };
  }
  if (safeLimit === 1) {
    return { content: '…', omittedCharacterCount: normalized.length };
  }

  let end = safeLimit - 1;
  const codeUnit = normalized.charCodeAt(end - 1);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) end -= 1;
  const prefix = normalized.slice(0, end).trimEnd();
  return {
    content: `${prefix}…`,
    omittedCharacterCount: normalized.length - prefix.length,
  };
}

function groupEventCount(group: SegmentGroup): number {
  return group.type === 'tool-call-group' ? group.calls.length : 1;
}

/**
 * 从末尾保留最近的处理事件。tool-call-group 会在组内裁剪，避免单个组含大量工具调用时
 * 绕过上限。原数组与对象保持只读，不修改会话真值。
 */
export function windowProcessingGroups(
  groups: readonly SegmentGroup[],
  limit: number = DEFAULT_PROCESSING_EVENT_LIMIT,
): ProcessingWindow {
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      groups: [],
      omittedCount: groups.reduce((sum, group) => sum + groupEventCount(group), 0),
    };
  }

  let remaining = Math.floor(limit);
  let omittedCount = 0;
  const selected: SegmentGroup[] = [];

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (remaining <= 0) {
      omittedCount += groupEventCount(group);
      continue;
    }

    if (group.type !== 'tool-call-group') {
      selected.push(group);
      remaining -= 1;
      continue;
    }

    const calls = group.calls;
    if (calls.length <= remaining) {
      selected.push(group);
      remaining -= calls.length;
      continue;
    }

    const keptCalls = calls.slice(calls.length - remaining);
    omittedCount += calls.length - keptCalls.length;
    selected.push({ ...group, calls: keptCalls } satisfies ToolCallGroup);
    remaining = 0;
  }

  selected.reverse();
  return { groups: selected, omittedCount };
}
