import type { MarkdownBlock, MarkdownHeadingBlock } from './markdownTypes.ts';
export type { MarkdownBlock } from './markdownTypes.ts';

function parseListLine(line: string) {
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) return { ordered: false, content: unordered[1] };
  const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, start: Number(ordered[1]), content: ordered[2] };
  return null;
}

function splitTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];
  const normalized = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaping = false;
  for (const char of normalized) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableDelimiterLine(line: string) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function isTableStart(lines: readonly string[], index: number) {
  if (index + 1 >= lines.length) return false;
  const headers = splitTableRow(lines[index]);
  return headers.length >= 2 && isTableDelimiterLine(lines[index + 1]);
}

function normalizeTableRow(cells: readonly string[], length: number) {
  return Array.from({ length }, (_, index) => cells[index] ?? '');
}

function looksLikeTableRow(line: string) {
  return splitTableRow(line).length >= 2;
}

function isMarkdownBlockStart(line: string) {
  const trimmed = line.trim();
  return Boolean(
    trimmed.match(/^```/) ||
      trimmed.match(/^(#{1,6})\s+/) ||
      trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/) ||
      trimmed.startsWith('>') ||
      looksLikeTableRow(line) ||
      parseListLine(line),
  );
}

export function parseMarkdownBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1], content: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        depth: heading[1].length as MarkdownHeadingBlock['depth'],
        content: heading[2],
      });
      index += 1;
      continue;
    }

    if (trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim()) {
        if (!looksLikeTableRow(lines[index])) break;
        rows.push(normalizeTableRow(splitTableRow(lines[index]), headers.length));
        index += 1;
      }
      blocks.push({
        type: 'table',
        headers,
        rows,
      });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = lines[index].match(/^\s*>\s?(.*)$/);
        if (!quote) break;
        quoteLines.push(quote[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') });
      continue;
    }

    const listLine = parseListLine(line);
    if (listLine) {
      const items: string[] = [listLine.content];
      const ordered = listLine.ordered;
      const start = listLine.start;
      index += 1;
      while (index < lines.length) {
        const nextListLine = parseListLine(lines[index]);
        if (!nextListLine || nextListLine.ordered !== ordered) break;
        items.push(nextListLine.content);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') });
  }

  return blocks;
}
