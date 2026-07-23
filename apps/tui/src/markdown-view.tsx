import type { ReactNode } from 'react';
import { useTerminalDimensions } from '@opentui/react';

import { COLOR, MARKDOWN_CHROME } from './tui-theme.ts';
import { ThemedText } from './themed-primitives.tsx';

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

    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1]!;
      const markerCharacter = marker[0]!;
      const isClosingFence = (candidate: string): boolean => {
        const trimmed = candidate.trim();
        return trimmed.length >= marker.length
          && [...trimmed].every((character) => character === markerCharacter);
      };
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[2]?.trim() ?? '', text: body.join('\n') });
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
    else nodes.push(<span key={key} fg={COLOR.link}>{match[7]}</span>);
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
        <ThemedText key={`diff-line-${index}`} selectable fg={diffLineColor(line)}>{line || ' '}</ThemedText>
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

const SUMMARY_HEADERS = new Set(['项', '字段', '属性', 'key', 'field', 'property']);
const SUMMARY_VALUE_HEADERS = new Set(['结果', '值', '说明', 'value', 'result', 'description']);
const GRID_GAP = 3;

function isSummaryTable(headers: readonly string[], rows: readonly (readonly string[])[]): boolean {
  if (headers.length !== 2 || rows.length === 0) return false;
  const first = headers[0]?.trim().toLowerCase() ?? '';
  const second = headers[1]?.trim().toLowerCase() ?? '';
  return rows.every((row) => displayWidth(row[0] ?? '') <= 16)
    && (SUMMARY_HEADERS.has(first) || SUMMARY_VALUE_HEADERS.has(second));
}

function columnWidths(headers: readonly string[], rows: readonly (readonly string[])[]): number[] {
  return headers.map((header, column) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(row[column] ?? '')),
  ));
}

function KeyValueTable({ rows, width }: { rows: readonly (readonly string[])[]; width: number }) {
  const keyWidth = Math.max(...rows.map((row) => displayWidth(row[0] ?? '')));
  const stacked = keyWidth + GRID_GAP + 12 > width;
  return (
    <box flexDirection="column" marginBottom={1}>
      {rows.map((row, index) => stacked ? (
        <box key={`summary-${index}`} flexDirection="column" marginBottom={index < rows.length - 1 ? 1 : 0}>
          <ThemedText selectable fg={COLOR.muted} attributes={1}>{inline(row[0] ?? '', `summary-key-${index}`)}</ThemedText>
          <box paddingLeft={2}><ThemedText selectable fg={COLOR.text}>{inline(row[1] ?? '', `summary-value-${index}`)}</ThemedText></box>
        </box>
      ) : (
        <box key={`summary-${index}`} flexDirection="row">
          <ThemedText selectable fg={COLOR.muted} attributes={1}>{padCell(row[0] ?? '', keyWidth, 'left')}{' '.repeat(GRID_GAP)}</ThemedText>
          <ThemedText selectable fg={COLOR.text} flexShrink={1}>{inline(row[1] ?? '', `summary-value-${index}`)}</ThemedText>
        </box>
      ))}
    </box>
  );
}

function StackedTable({ headers, rows }: { headers: readonly string[]; rows: readonly (readonly string[])[] }) {
  const labelWidth = Math.max(...headers.map(displayWidth));
  return (
    <box flexDirection="column" marginBottom={1}>
      {rows.map((row, rowIndex) => (
        <box key={`stacked-${rowIndex}`} flexDirection="column" marginBottom={rowIndex < rows.length - 1 ? 1 : 0}>
          <ThemedText selectable fg={COLOR.muted} attributes={1}>[{rowIndex + 1}]</ThemedText>
          {headers.map((header, column) => (
            <box key={`stacked-${rowIndex}-${column}`} flexDirection="row" paddingLeft={2}>
              <ThemedText selectable fg={COLOR.muted}>{padCell(header, labelWidth, 'left')}{'  '}</ThemedText>
              <ThemedText selectable fg={COLOR.text} flexShrink={1}>{inline(row[column] ?? '', `stacked-${rowIndex}-${column}`)}</ThemedText>
            </box>
          ))}
        </box>
      ))}
    </box>
  );
}

function DataTable({ headers, rows, alignments }: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  alignments: readonly TableAlignment[];
}) {
  const widths = columnWidths(headers, rows);
  const renderRow = (cells: readonly string[]) => widths.map((width, column) => (
    padCell(cells[column] ?? '', width, alignments[column] ?? 'left')
  )).join(' '.repeat(GRID_GAP));
  return (
    <box flexDirection="column" marginBottom={1}>
      <ThemedText selectable fg={COLOR.textSoft} attributes={1}>{renderRow(headers)}</ThemedText>
      <ThemedText selectable fg={COLOR.muted}>{widths.map((width) => '─'.repeat(width)).join(' '.repeat(GRID_GAP))}</ThemedText>
      {rows.map((row, index) => <ThemedText key={`row-${index}`} selectable fg={COLOR.text}>{renderRow(row)}</ThemedText>)}
    </box>
  );
}

function TableBlock({ headers, rows, alignments, width }: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly alignments: readonly TableAlignment[];
  readonly width: number;
}) {
  if (isSummaryTable(headers, rows)) return <KeyValueTable rows={rows} width={width} />;
  const naturalWidth = columnWidths(headers, rows).reduce((sum, value) => sum + value, 0)
    + Math.max(0, headers.length - 1) * GRID_GAP;
  if (naturalWidth > width) return <StackedTable headers={headers} rows={rows} />;
  return <DataTable headers={headers} rows={rows} alignments={alignments} />;
}

export function MarkdownView({ content, width }: { content: string; width?: number }) {
  const terminal = useTerminalDimensions();
  const availableWidth = Math.max(20, width ?? terminal.width);
  const blocks = parseBlocks(content || ' ');
  return (
    <box flexDirection="column">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        // Space separates Markdown blocks; the final block must not add a tail
        // because the enclosing conversation turn owns inter-message rhythm.
        const marginBottom = index < blocks.length - 1 ? 1 : 0;
        if (block.type === 'heading') {
          const prefix = block.level === 1
            ? MARKDOWN_CHROME.headingH1
            : block.level === 2
              ? MARKDOWN_CHROME.headingH2
              : MARKDOWN_CHROME.headingH3;
          return <ThemedText key={key} selectable fg={block.level <= 2 ? COLOR.accent : COLOR.text} marginBottom={marginBottom}><strong>{prefix}{inline(block.text, key)}</strong></ThemedText>;
        }
        if (block.type === 'code') {
          return (
            <box key={key} flexDirection="column" backgroundColor={COLOR.codeBackground} paddingLeft={1} paddingRight={1} marginBottom={marginBottom}>
              {block.language ? <ThemedText selectable fg={COLOR.muted}>{block.language}</ThemedText> : null}
              {block.language.toLowerCase() === 'diff'
                ? <DiffCodeBlock text={block.text} />
                : <ThemedText selectable fg={COLOR.text}>{block.text || ' '}</ThemedText>}
            </box>
          );
        }
        if (block.type === 'quote') return <ThemedText key={key} selectable fg={COLOR.muted} marginBottom={marginBottom}>{MARKDOWN_CHROME.quotePrefix}{inline(block.text, key)}</ThemedText>;
        if (block.type === 'rule') return <ThemedText key={key} selectable fg={COLOR.muted} marginBottom={marginBottom}>────────────────────────────────────────</ThemedText>;
        if (block.type === 'list') {
          return (
            <box key={key} flexDirection="column" marginBottom={marginBottom}>
              {block.items.map((item, itemIndex) => (
                <ThemedText key={`${key}-${itemIndex}`} selectable fg={COLOR.text}>{block.ordered ? `${itemIndex + 1}. ` : MARKDOWN_CHROME.listBullet}{inline(item, `${key}-${itemIndex}`)}</ThemedText>
              ))}
            </box>
          );
        }
        if (block.type === 'table') {
          return (
            <box key={key} marginBottom={marginBottom}>
              <TableBlock
                headers={block.headers}
                rows={block.rows}
                alignments={block.alignments}
                width={availableWidth}
              />
            </box>
          );
        }
        return <ThemedText key={key} selectable fg={COLOR.text} marginBottom={marginBottom}>{inline(block.text, key)}</ThemedText>;
      })}
    </box>
  );
}
