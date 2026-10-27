import type { ResourceFeedback } from '@peer-agent/protocol';
import { RESOURCE_FEEDBACK_EXCERPT_LIMIT } from '@peer-agent/protocol';
export interface ResourceTextSelection { readonly excerpt: string; readonly selection: ResourceFeedback['selection'] }
/** Map only source text spans. Gutter/rendered Markdown/Diff DOM cannot manufacture source coordinates. */
export function sourceSelection(container: HTMLElement, range: Range, content: string): ResourceTextSelection | null {
  const locate = (node: Node, offset: number) => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const text = element?.closest('.source-line-text');
    const line = text?.closest<HTMLElement>('[data-source-line]');
    if (!text || !line || !container.contains(text)) return null;
    const number = Number(line.dataset.sourceLine), lines = content.split('\n');
    if (!Number.isSafeInteger(number) || number < 1 || number > lines.length) return null;
    const before = range.cloneRange(); before.selectNodeContents(text);
    try { before.setEnd(node, offset); } catch { return null; }
    const column = Math.min(lines[number - 1]!.length, before.toString().length);
    return { offset: lines.slice(0, number - 1).reduce((sum, line) => sum + line.length + 1, 0) + column, line: number, column: column + 1 };
  };
  const a = locate(range.startContainer, range.startOffset), b = locate(range.endContainer, range.endOffset);
  if (!a || !b || b.offset <= a.offset) return null;
  const excerpt = content.slice(a.offset, b.offset);
  if (!excerpt.trim() || excerpt.length > RESOURCE_FEEDBACK_EXCERPT_LIMIT) return null;
  return { excerpt, selection: { kind: 'source', range: { start: a.offset, end: b.offset, startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column } } };
}
export function captureResourceSelection(container: HTMLElement, selected: Selection | null, sourceContent?: string, path?: string): ResourceTextSelection | null {
  if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return null;
  const range = selected.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  if (sourceContent !== undefined) { const mapped = sourceSelection(container, range, sourceContent); if (mapped) return mapped; }
  const excerpt = selected.toString();
  if (!excerpt.trim() || excerpt.length > RESOURCE_FEEDBACK_EXCERPT_LIMIT) return null;
  return { excerpt, selection: { kind: 'discussion', ...(path ? { path } : {}) } };
}
export async function feedbackDigest(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
