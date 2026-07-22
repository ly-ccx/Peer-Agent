import type { ReactNode } from 'react';

import { COLOR } from './tui-theme.ts';

type TableAlignment = 'left' | 'center' | 'right';

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'rule' }
  | { type: 'table'; headers: string[]; rows: string[][]; alignments: TableAlignment[] };

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTableAlignments(separatorLine: string): TableAlignment[] {
  return splitTableRow(separatorLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1]?.trim() ?? '', text: body.join('\n') });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const quoted = [quote[1] ?? ''];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? '').match(/^\s*>\s?(.*)$/);
        if (!next) break;
        quoted.push(next[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', text: quoted.join(' ') });
      continue;
    }

    const listItem = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (listItem) {
      const ordered = Boolean(listItem[2]);
      const items = [listItem[3]!];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? '').match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!next || Boolean(next[2]) !== ordered) break;
        items.push(next[3]!);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // GFM table: header row | delimiter row | data rows
    if (isTableRow(line) && index + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[index + 1] ?? '')) {
      const headers = splitTableRow(line);
      const alignments = parseTableAlignments(lines[index + 1]!);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? '') && !(lines[index] ?? '').match(/^\s*```/) && !(lines[index] ?? '').match(/^\s{0,3}#{1,6}\s+/)) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows, alignments });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim()) {
      const next = lines[index] ?? '';
      if (/^\s*```/.test(next) || /^\s{0,3}#{1,6}\s+/.test(next) || /^\s*>/.test(next) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(next)) break;
      // Stop paragraph collection if we hit a table start
      if (isTableRow(next) && index + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[index + 1] ?? '')) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(`+)(.+?)\3|(\*|_)(.+?)\5|\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[2] !== undefined) nodes.push(<strong key={key}>{inline(match[2], key)}</strong>);
    else if (match[4] !== undefined) nodes.push(<span key={key} fg={COLOR.code} bg={COLOR.codeBackground}>{match[4]}</span>);
    else if (match[6] !== undefined) nodes.push(<em key={key}>{inline(match[6], key)}</em>);
    else nodes.push(<span key={key} fg="#7dd3fc">{match[7]}</span>);
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function diffLineColor(line: string): string {
  if (line.startsWith('@@')) return COLOR.diffHunk;
  if (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('\\ No newline at end of file')
  ) return COLOR.diffMeta;
  if (line.startsWith('+')) return COLOR.diffAdd;
  if (line.startsWith('-')) return COLOR.diffDelete;
  return COLOR.text;
}

function DiffCodeBlock({ text }: { text: string }) {
  return (
    <box flexDirection="column">
      {(text || ' ').split('\n').map((line, index) => (
        <text key={`diff-line-${index}`} selectable fg={diffLineColor(line)}>{line || ' '}</text>
      ))}
    </box>
  );
}

/** Compute display width of a string, counting wide CJK characters as 2 columns. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1100 && (
      code <= 0x115f
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xa000 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    )) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padCell(text: string, width: number, alignment: TableAlignment): string {
  const gap = Math.max(0, width - displayWidth(text));
  if (alignment === 'right') return `${' '.repeat(gap)}${text}`;
  if (alignment === 'center') {
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return `${' '.repeat(left)}${text}${' '.repeat(right)}`;
  }
  return `${text}${' '.repeat(gap)}`;
}

function TableBlock({ headers, rows, alignments }: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly alignments: readonly TableAlignment[];
}) {
  const columnCount = headers.length;
  const colWidths = headers.map((h, i) => displayWidth(h));

  for (const row of rows) {
    for (let i = 0; i < columnCount; i += 1) {
      const cellWidth = displayWidth(row[i] ?? '');
      if (cellWidth > (colWidths[i] ?? 0)) colWidths[i] = cellWidth;
    }
  }

  const renderRow = (cells: readonly string[], isHeader: boolean) => {
    const parts = cells.slice(0, columnCount).map((cell, i) =>
      padCell(cell ?? '', colWidths[i] ?? 0, alignments[i] ?? 'left'),
    );
    while (parts.length < columnCount) {
      parts.push(padCell('', colWidths[parts.length] ?? 0, alignments[parts.length] ?? 'left'));
    }
    return ` ${parts.join(' │ ')} `;
  };

  const separator = ` ${colWidths.map((w, i) => {
    const a = alignments[i] ?? 'left';
    const left = a === 'center' || a === 'right' ? ':' : '';
    const right = a === 'center' || a === 'left' ? ':' : '';
    return `${left}${'─'.repeat(Math.max(2, w))}${right}`;
  }).join('─┼─')} `;

  const headerLine = renderRow(headers, true);
  const dataLines = rows.map((row) => renderRow(row, false));

  return (
    <box flexDirection="column" marginBottom={1}>
      <text selectable fg={COLOR.textSoft}><strong>{headerLine}</strong></text>
      <text selectable fg={COLOR.muted}>{separator}</text>
      {dataLines.map((line, i) => (
        <text key={`row-${i}`} selectable fg={COLOR.text}>{line}</text>
      ))}
    </box>
  );
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <box flexDirection="column">
      {parseBlocks(content || ' ').map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'heading') {
          const prefix = block.level === 1 ? '▌ ' : block.level === 2 ? '▸ ' : '• ';
          return <text key={key} selectable fg={block.level <= 2 ? COLOR.accent : COLOR.text} marginBottom={1}><strong>{prefix}{inline(block.text, key)}</strong></text>;
        }
        if (block.type === 'code') {
          return (
            <box key={key} flexDirection="column" backgroundColor={COLOR.codeBackground} paddingLeft={1} paddingRight={1} marginBottom={1}>
              {block.language ? <text selectable fg={COLOR.muted}>{block.language}</text> : null}
              {block.language.toLowerCase() === 'diff'
                ? <DiffCodeBlock text={block.text} />
                : <text selectable fg={COLOR.text}>{block.text || ' '}</text>}
            </box>
          );
        }
        if (block.type === 'quote') return <text key={key} selectable fg={COLOR.muted} marginBottom={1}>│ {inline(block.text, key)}</text>;
        if (block.type === 'rule') return <text key={key} selectable fg={COLOR.muted} marginBottom={1}>────────────────────────────────────────</text>;
        if (block.type === 'list') {
          return (
            <box key={key} flexDirection="column" marginBottom={1}>
              {block.items.map((item, itemIndex) => (
                <text key={`${key}-${itemIndex}`} selectable>{block.ordered ? `${itemIndex + 1}. ` : '• '}{inline(item, `${key}-${itemIndex}`)}</text>
              ))}
            </box>
          );
        }
        if (block.type === 'table') {
          return (
            <TableBlock
              key={key}
              headers={block.headers}
              rows={block.rows}
              alignments={block.alignments}
            />
          );
        }
        return <text key={key} selectable fg={COLOR.text} marginBottom={1}>{inline(block.text, key)}</text>;
      })}
    </box>
  );
}
