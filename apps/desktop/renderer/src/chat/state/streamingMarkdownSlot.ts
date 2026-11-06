/**
 * 流式正文的开放块。
 *
 * 已闭合的块进入不可变数组，后续 delta 只改写开放尾部。Markdown 视图用这份
 * 引用跳过已闭合块的重解析；未闭合围栏留在 openText 里，不高亮。
 * 槽位挂在文本段对象上（WeakMap），不进入可持久化字段。
 */
import { looksLikeProseNotCode } from '../components/markdown/markdownFenceSanitizer.ts';
import { parseMarkdownBlocks, type MarkdownBlock } from '../components/markdown/markdownParser.ts';

export interface MarkdownOpenSlot {
  readonly sourceLength: number;
  readonly closedSourceLength: number;
  readonly closed: readonly MarkdownBlock[];
  readonly openText: string;
  readonly openKind: 'empty' | 'prose' | 'fence';
  readonly fenceLanguage?: string;
}

const EMPTY_CLOSED: readonly MarkdownBlock[] = Object.freeze([]);

interface StreamingTail {
  readonly start: number;
  readonly kind: 'empty' | 'prose' | 'fence';
  readonly fenceLanguage?: string;
}

function lineIndex(source: string): { readonly lines: readonly string[]; readonly starts: readonly number[] } {
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { lines, starts };
}

function lineTerminated(source: string, index: number, lineCount: number): boolean {
  return index < lineCount - 1 || source.endsWith('\n');
}

function parseListLine(line: string): { ordered: boolean } | null {
  if (/^\s*[-*+]\s+(.+)$/.test(line)) return { ordered: false };
  if (/^\s*(\d+)[.)]\s+(.+)$/.test(line)) return { ordered: true };
  return null;
}

function isFenceOpenLine(line: string): RegExpMatchArray | null {
  return line.trim().match(/^```([A-Za-z0-9_-]+)?\s*$/);
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(
    isFenceOpenLine(line)
    || /^\s*(#{1,6})\s+/.test(line)
    || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || trimmed.startsWith('>')
    || parseListLine(line),
  );
}

/**
 * 开放尾从这里开始。之前的源码都已经收成不可变块。
 * 仍可能被下一个 delta 续写的段落 / 列表 / 引用 / 表格 / 未闭合围栏留在尾部。
 */
export function locateStreamingTail(source: string): StreamingTail {
  if (!source) return { start: 0, kind: 'empty' };
  const { lines, starts } = lineIndex(source);
  let openStart = source.length;
  let openKind: StreamingTail['kind'] = 'empty';
  let fenceLanguage: string | undefined;
  let index = 0;

  const markClosed = () => {
    openStart = source.length;
    openKind = 'empty';
    fenceLanguage = undefined;
  };
  const markProse = (start: number) => {
    openStart = start;
    openKind = 'prose';
    fenceLanguage = undefined;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      // "hello\n" 经 split 会多出最后一行空串，那只是行尾换行，段落仍可续写。
      // 真正的空行（hello\n\n）才会把前面的块收口。
      const trailingTerminator = index === lines.length - 1 && source.endsWith('\n');
      if (!trailingTerminator) markClosed();
      index += 1;
      continue;
    }

    const fence = isFenceOpenLine(line);
    if (fence) {
      const fenceStart = starts[index] ?? 0;
      const fenceLine = index;
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) index += 1;
      if (index >= lines.length) {
        const body = lines.slice(fenceLine + 1).join('\n');
        if (looksLikeProseNotCode(body)) return { start: fenceStart, kind: 'prose' };
        return { start: fenceStart, kind: 'fence', fenceLanguage: fence[1] };
      }
      index += 1;
      markClosed();
      continue;
    }

    if (/^\s*(#{1,6})\s+/.test(line)) {
      const start = starts[index] ?? 0;
      const terminated = lineTerminated(source, index, lines.length);
      index += 1;
      if (!terminated) return { start, kind: 'prose' };
      markClosed();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const start = starts[index] ?? 0;
      const terminated = lineTerminated(source, index, lines.length);
      index += 1;
      if (!terminated) return { start, kind: 'prose' };
      markClosed();
      continue;
    }

    if (trimmed.startsWith('>')) {
      const start = starts[index] ?? 0;
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) index += 1;
      markProse(start);
      continue;
    }

    const listLine = parseListLine(line);
    if (listLine) {
      const start = starts[index] ?? 0;
      const ordered = listLine.ordered;
      index += 1;
      while (index < lines.length) {
        const next = parseListLine(lines[index] ?? '');
        if (!next || next.ordered !== ordered) break;
        index += 1;
      }
      while (index < lines.length) {
        let probe = index;
        while (probe < lines.length && !(lines[probe] ?? '').trim()) probe += 1;
        if (probe === index || probe >= lines.length) break;
        const continuation = parseListLine(lines[probe] ?? '');
        if (!continuation || continuation.ordered !== ordered) break;
        index = probe + 1;
      }
      markProse(start);
      continue;
    }

    const start = starts[index] ?? 0;
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !isBlockStart(lines[index] ?? '')) {
      index += 1;
    }
    markProse(start);
  }

  return { start: openStart, kind: openKind, fenceLanguage };
}

export function advanceMarkdownOpenSlot(
  previous: MarkdownOpenSlot | null | undefined,
  source: string,
): MarkdownOpenSlot {
  const canExtend = Boolean(
    previous
    && source.length >= previous.sourceLength
    && source.slice(previous.closedSourceLength, previous.sourceLength) === previous.openText,
  );

  if (canExtend && previous) {
    const delta = source.slice(previous.sourceLength);
    if (previous.openKind === 'fence' && !delta.includes('```')) {
      return {
        ...previous,
        sourceLength: source.length,
        openText: previous.openText + delta,
      };
    }

    const boundary = locateStreamingTail(source.slice(previous.closedSourceLength));
    const closedSourceLength = previous.closedSourceLength + boundary.start;
    const openText = source.slice(closedSourceLength);
    if (closedSourceLength === previous.closedSourceLength) {
      if (
        previous.sourceLength === source.length
        && previous.openText === openText
        && previous.openKind === boundary.kind
        && previous.fenceLanguage === boundary.fenceLanguage
      ) {
        return previous;
      }
      return {
        ...previous,
        sourceLength: source.length,
        openText,
        openKind: boundary.kind,
        fenceLanguage: boundary.fenceLanguage,
      };
    }

    const newlyClosed = parseMarkdownBlocks(source.slice(previous.closedSourceLength, closedSourceLength));
    return {
      sourceLength: source.length,
      closedSourceLength,
      closed: previous.closed.length === 0 ? newlyClosed : [...previous.closed, ...newlyClosed],
      openText,
      openKind: boundary.kind,
      fenceLanguage: boundary.fenceLanguage,
    };
  }

  const boundary = locateStreamingTail(source);
  const closedSource = source.slice(0, boundary.start);
  return {
    sourceLength: source.length,
    closedSourceLength: boundary.start,
    closed: closedSource ? parseMarkdownBlocks(closedSource) : EMPTY_CLOSED,
    openText: source.slice(boundary.start),
    openKind: boundary.kind,
    fenceLanguage: boundary.fenceLanguage,
  };
}

export function openFenceBody(openText: string): { readonly language?: string; readonly code: string } | null {
  const lines = openText.split('\n');
  let start = 0;
  while (start < lines.length && !(lines[start] ?? '').trim()) start += 1;
  const fence = isFenceOpenLine(lines[start] ?? '');
  if (!fence) return null;
  return { language: fence[1], code: lines.slice(start + 1).join('\n') };
}

const slots = new WeakMap<object, MarkdownOpenSlot>();

/** 新的文本段对象。开放块槽挂在对象身份上，序列化进主进程时不会出现。 */
export function nextStreamingTextSegment(
  previous: { readonly content?: string } | undefined,
  content: string,
): { type: 'text'; content: string } {
  const segment = { type: 'text' as const, content };
  const previousSlot = previous ? slots.get(previous) : undefined;
  slots.set(segment, advanceMarkdownOpenSlot(previousSlot, content));
  return segment;
}

export function readStreamingOpenSlot(segment: object | null | undefined): MarkdownOpenSlot | undefined {
  if (!segment) return undefined;
  return slots.get(segment);
}
