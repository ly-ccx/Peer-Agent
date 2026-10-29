import { hasMalformedUnifiedHunks } from './diffHunkState.ts';
import { boundedPresentation, DIFF_BUDGET } from './presentationBudget.ts';
export function prepareDiffPresentation(text: string) {
  const bounded = boundedPresentation(text, DIFF_BUDGET);
  const withinBudget = !bounded.truncated && bounded.maxLineLength <= 16_000;
  const malformedHunk = withinBudget && hasMalformedUnifiedHunks(bounded.text);
  const metadataOnlyFile = withinBudget && text.split(/^diff --git /m).some(part => part.trim() && !/^@@ -/m.test(part));
  const reason = bounded.truncated || bounded.maxLineLength > 16_000 ? 'budget' : /^(?:diff --(?:cc|combined) |@@@)/m.test(text) ? 'combined'
    : /^(?:GIT binary patch|Binary files? )/m.test(text) ? 'binary'
    : malformedHunk ? 'structure'
    : /^(?:old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/m.test(text) || metadataOnlyFile ? 'metadata' : null;
  return { ...bounded, mode: reason ? 'raw' as const : 'unified' as const, reason };
}
export function diffFallbackLabel(reason: string | null, isZh: boolean) {
  const messages: Record<string, readonly [string, string]> = {
    budget: ['Diff 超出结构化展示限额，显示受限原始文本。', 'This diff exceeds the structured display budget. Bounded raw text is shown.'],
    combined: ['合并 Diff 暂不支持双向行号，以下保留原始文本。', 'Combined diffs do not support two-way line numbering here. Raw text is preserved below.'],
    binary: ['这是二进制差异记录，不代表可读取二进制正文。', 'This is a binary difference record, not a readable binary document.'],
    structure: ['此 Diff 结构无法确认，按原始文本显示。', 'This diff structure could not be confirmed. Raw text is shown.'],
    metadata: ['当前记录包含需保留的元数据或非标准差异，按原始文本显示。', 'This record includes metadata or nonstandard differences that require a raw text view.'],
  };
  return messages[reason ?? '']?.[isZh ? 0 : 1] ?? '';
}
