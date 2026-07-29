import { joinSummaryThinkingContent } from './thinkingSummaryJoin.ts';
import type { ChatMsg, ContentSegment, ThinkingKind } from './types.ts';

export type BackgroundStreamOperation =
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'thinking'; readonly content: string; readonly kind?: ThinkingKind };

export interface BackgroundStreamPatch {
  readonly conversationId: string;
  readonly operations: readonly BackgroundStreamOperation[];
}

export function applyBackgroundStreamOperations(
  messages: readonly ChatMsg[],
  operations: readonly BackgroundStreamOperation[],
): ChatMsg[] {
  let next = messages as ChatMsg[];
  for (const operation of operations) {
    next = operation.type === 'text'
      ? appendText(next, operation.content)
      : appendThinking(next, operation.content, operation.kind);
  }
  return next;
}

export class BackgroundStreamBuffer {
  private readonly pending = new Map<string, BackgroundStreamOperation[]>();

  pushText(conversationId: string, content: string): void {
    if (!content) return;
    this.push(conversationId, { type: 'text', content });
  }

  pushThinking(conversationId: string, content: string, kind?: ThinkingKind): void {
    if (!content) return;
    this.push(conversationId, { type: 'thinking', content, kind });
  }

  drain(conversationId?: string): BackgroundStreamPatch[] {
    if (conversationId) {
      const operations = this.pending.get(conversationId);
      if (!operations?.length) return [];
      this.pending.delete(conversationId);
      return [{ conversationId, operations }];
    }

    const patches: BackgroundStreamPatch[] = [];
    for (const [cid, operations] of this.pending) {
      patches.push({ conversationId: cid, operations });
    }
    this.pending.clear();
    return patches;
  }

  clear(): void {
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  private push(conversationId: string, operation: BackgroundStreamOperation): void {
    const operations = this.pending.get(conversationId);
    if (operations) {
      operations.push(operation);
      return;
    }
    this.pending.set(conversationId, [operation]);
  }
}

/** 追加正文 delta：合并到尾部 text 段，否则新起 text 段。非 assistant 尾返回原数组。 */
function appendText(messages: readonly ChatMsg[], chunk: string): ChatMsg[] {
  const prev = messages as ChatMsg[];
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (!last || last.role !== 'assistant') return prev;
  const segments = [...(last.segments || [])];
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lastSeg.type === 'text') {
    segments[segments.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + chunk };
  } else {
    segments.push({ type: 'text', content: chunk });
  }
  return [...prev.slice(0, -1), { ...last, content: getTextContent(segments), segments }];
}

/** 追加思考 delta：仅与同 kind 的尾部 thinking 段合并；kind 变化或工具调用后新起一段。 */
function appendThinking(
  messages: readonly ChatMsg[],
  chunk: string,
  kind?: ThinkingKind,
): ChatMsg[] {
  const prev = messages as ChatMsg[];
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (!last || last.role !== 'assistant') return prev;
  const segments = [...(last.segments || [])];
  const lastSeg = segments[segments.length - 1];
  const sameKind =
    lastSeg
    && lastSeg.type === 'thinking'
    && (lastSeg.kind || undefined) === (kind || undefined);
  if (sameKind && lastSeg.type === 'thinking') {
    const nextKind = kind || lastSeg.kind;
    const joined =
      nextKind === 'summary'
        ? joinSummaryThinkingContent(lastSeg.content || '', chunk)
        : (lastSeg.content || '') + chunk;
    segments[segments.length - 1] = nextKind
      ? { type: 'thinking', content: joined, kind: nextKind }
      : { type: 'thinking', content: joined };
  } else {
    segments.push(kind ? { type: 'thinking', content: chunk, kind } : { type: 'thinking', content: chunk });
  }
  return [...prev.slice(0, -1), { ...last, segments }];
}

function getTextContent(segments: readonly ContentSegment[]): string {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.content || '')
    .join('');
}
