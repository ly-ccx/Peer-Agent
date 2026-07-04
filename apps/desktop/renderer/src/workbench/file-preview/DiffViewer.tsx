import { useMemo } from 'react';

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

interface DiffLine {
  readonly kind: LineKind;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

interface DiffViewerProps {
  readonly diffText: string;
}

function parseHunkHeader(line: string): readonly [number, number] | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function classifyLine(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('Binary ')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export function buildDiffLines(text: string): DiffLine[] {
  if (!text) return [];
  const out: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const raw of text.replace(/\n$/, '').split('\n')) {
    const kind = classifyLine(raw);
    if (kind === 'hunk') {
      const parsed = parseHunkHeader(raw);
      if (parsed) {
        oldCursor = parsed[0];
        newCursor = parsed[1];
      }
      out.push({ kind, text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (kind === 'meta') {
      out.push({ kind, text: raw, oldNo: null, newNo: null });
      continue;
    }
    const body = raw.slice(1);
    if (kind === 'add') {
      out.push({ kind, text: body, oldNo: null, newNo: newCursor });
      newCursor += 1;
      continue;
    }
    if (kind === 'del') {
      out.push({ kind, text: body, oldNo: oldCursor, newNo: null });
      oldCursor += 1;
      continue;
    }
    out.push({ kind, text: body, oldNo: oldCursor, newNo: newCursor });
    oldCursor += 1;
    newCursor += 1;
  }
  return out;
}

export function DiffViewer({ diffText }: DiffViewerProps) {
  const lines = useMemo(() => buildDiffLines(diffText), [diffText]);

  return (
    <pre className="workbench-diff-pre">
      <code>
        {lines.map((line, i) => (
          <span key={i} className={`diff-line diff-line--${line.kind}`}>
            <span className="diff-gutter diff-gutter--old" aria-hidden="true">
              {line.oldNo ?? ''}
            </span>
            <span className="diff-gutter diff-gutter--new" aria-hidden="true">
              {line.newNo ?? ''}
            </span>
            <span className="diff-line-text">{line.text === '' ? '\u00a0' : line.text}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
