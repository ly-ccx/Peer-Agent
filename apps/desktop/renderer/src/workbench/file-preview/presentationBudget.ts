/** Renderer budgets are presentation limits, never read limits or content versions. */
export const SOURCE_BUDGET = { characters: 200_000, lines: 4_000 } as const;
export const MARKDOWN_BUDGET = { characters: 100_000, lines: 2_000 } as const;
export const DIFF_BUDGET = { characters: 500_000, lines: 8_000 } as const;
export function boundedPresentation(content: string, budget = SOURCE_BUDGET as { readonly characters: number; readonly lines: number }) {
  let end = Math.min(content.length, budget.characters), totalLines = content ? 1 : 0, shownLines = content ? 1 : 0, lineStart = 0, maxLineLength = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '\n') continue;
    maxLineLength = Math.max(maxLineLength, i - lineStart); lineStart = i + 1;
    totalLines++;
    if (i < end) {
      if (shownLines >= budget.lines) end = i;
      else shownLines++;
    }
  }
  maxLineLength = Math.max(maxLineLength, content.length - lineStart);
  if (end > 0 && end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
  const text = content.slice(0, end);
  return { text, maxLineLength, truncated: end < content.length, totalLines, shownLines: text ? text.split('\n').length : 0, shownCharacters: end };
}
export function presentationLimitLabel(shown: { shownLines: number; totalLines: number }, isZh: boolean): string {
  return isZh ? `当前仅展示前 ${shown.shownLines} 行的受限内容（共 ${shown.totalLines} 行），原文未修改。`
    : `Showing a bounded portion of the first ${shown.shownLines} lines (${shown.totalLines} total). The original is unchanged.`;
}
