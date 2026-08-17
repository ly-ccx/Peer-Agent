import { highlightCode } from '../../chat/components/markdown/codeHighlighter.ts';

export interface HighlightedSourceLines {
  readonly language: string | null;
  readonly lines: readonly string[];
}

/**
 * 把 highlight.js 输出按源码换行切开，同时把跨行 span 补回每一行，
 * 这样 SourceViewer 可以继续用现有 gutter，而不打乱 token 着色。
 */
export function splitHighlightedHtmlByLine(html: string): string[] {
  const lines: string[] = [];
  let current = '';
  const openTags: string[] = [];
  const tagRe = /<\/?span\b[^>]*>|\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    current += html.slice(lastIndex, match.index);
    const token = match[0];
    if (token === '\n') {
      lines.push(current + closeOpenTags(openTags));
      current = reopenTags(openTags);
    } else if (token.startsWith('</')) {
      current += token;
      openTags.pop();
    } else {
      current += token;
      openTags.push(token);
    }
    lastIndex = tagRe.lastIndex;
  }

  current += html.slice(lastIndex);
  lines.push(current + closeOpenTags(openTags));
  return lines;
}

function closeOpenTags(openTags: readonly string[]): string {
  return '</span>'.repeat(openTags.length);
}

function reopenTags(openTags: readonly string[]): string {
  return openTags.join('');
}

/**
 * 按语言高亮整份源码，再拆成带 token 的行。
 * 未知语言、超长文件或高亮失败时返回纯文本行。
 */
export function highlightSourceLines(content: string, language: string | null | undefined): HighlightedSourceLines {
  const plainLines = content.split('\n');
  if (!language) {
    return { language: null, lines: plainLines };
  }

  const highlighted = highlightCode(content, language);
  if (!highlighted.html) {
    return { language: null, lines: plainLines };
  }

  const lines = splitHighlightedHtmlByLine(highlighted.html);
  if (lines.length !== plainLines.length) {
    return { language: null, lines: plainLines };
  }

  return { language: highlighted.language, lines };
}
