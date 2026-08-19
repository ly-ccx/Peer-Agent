export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

function parseHunkHeader(line: string): readonly [number, number] | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function classifyLine(line: string): DiffLineKind {
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

/**
 * 行号只在见到 unified diff 的 @@ hunk 头之后才赋值。
 * 没有 hunk 时保持 null，避免把 0 这种假行号画进 gutter。
 */
export function buildDiffLines(text: string): DiffLine[] {
  if (!text) return [];
  const out: DiffLine[] = [];
  let oldCursor: number | null = null;
  let newCursor: number | null = null;
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
      const newNo = newCursor;
      if (newCursor != null) newCursor += 1;
      out.push({ kind, text: body, oldNo: null, newNo });
      continue;
    }
    if (kind === 'del') {
      const oldNo = oldCursor;
      if (oldCursor != null) oldCursor += 1;
      out.push({ kind, text: body, oldNo, newNo: null });
      continue;
    }
    const oldNo = oldCursor;
    const newNo = newCursor;
    if (oldCursor != null) oldCursor += 1;
    if (newCursor != null) newCursor += 1;
    out.push({ kind, text: body, oldNo, newNo });
  }
  return out;
}
