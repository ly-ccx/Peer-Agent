import type { ReactNode } from 'react';

import { COLOR } from './tui-theme.ts';

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'rule' };

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

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim()) {
      const next = lines[index] ?? '';
      if (/^\s*```/.test(next) || /^\s{0,3}#{1,6}\s+/.test(next) || /^\s*>/.test(next) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(next)) break;
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
        return <text key={key} selectable fg={COLOR.text} marginBottom={1}>{inline(block.text, key)}</text>;
      })}
    </box>
  );
}
