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

export interface DiffFileGroup {
  readonly path: string;
  readonly fromPath?: string;
  readonly lines: readonly DiffLine[];
}

export function decodeGitPath(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const body = token.slice(1, -1), bytes: number[] = [], encoder = new TextEncoder();
  const escapes: Record<string, number> = { t: 9, n: 10, r: 13, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
  for (let index = 0; index < body.length;) {
    if (body[index] === '\\') {
      const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8)); index += octal[0].length + 1; continue; }
      const escaped = body[index + 1];
      if (escaped && escaped in escapes) { bytes.push(escapes[escaped]!); index += 2; continue; }
    }
    const character = String.fromCodePoint(body.codePointAt(index)!);
    bytes.push(...encoder.encode(character)); index += character.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function gitPathFromHeader(rest: string): string {
  let token = rest.trim();
  const tab = token.indexOf('\t');
  if (tab >= 0) token = token.slice(0, tab).trim();
  token = decodeGitPath(token);
  if (!token || token === '/dev/null') return '';
  return token.replace(/^[ab]\//, '');
}

function pathsFromDiffGit(line: string): { path: string; fromPath: string } | null {
  const match = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(line);
  if (!match) return null;
  return { fromPath: decodeGitPath(match[1] ?? '').replace(/^a\//, ''), path: decodeGitPath(match[2] ?? '').replace(/^b\//, '') };
}

/**
 * 把 unified diff 收成「文件名 + 真正改动」。
 * `diff --git` / `index` / `--- a/` / `+++ b/` 只是定位，不进行列表。
 */
export function groupDiffByFile(text: string): DiffFileGroup[] {
  const grouped: Array<{ path: string; fromPath?: string; lines: DiffLine[] }> = [];
  let current: { path: string; fromPath?: string; lines: DiffLine[] } | null = null;

  const ensureFile = (): { path: string; fromPath?: string; lines: DiffLine[] } => {
    if (!current) {
      current = { path: '', lines: [] };
      grouped.push(current);
    }
    return current;
  };

  for (const line of buildDiffLines(text)) {
    if (line.kind !== 'meta') {
      ensureFile().lines.push(line);
      continue;
    }
    const raw = line.text;
    if (raw.startsWith('diff --git')) {
      const parsed = pathsFromDiffGit(raw);
      current = {
        path: parsed?.path || parsed?.fromPath || '',
        ...(parsed && parsed.fromPath && parsed.fromPath !== parsed.path
          ? { fromPath: parsed.fromPath }
          : {}),
        lines: [],
      };
      grouped.push(current);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = gitPathFromHeader(raw.slice(4));
      if (path) ensureFile().path = path;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const path = gitPathFromHeader(raw.slice(4));
      if (path && !ensureFile().path) ensureFile().path = path;
      if (path) ensureFile().fromPath = path;
      continue;
    }
    if (raw.startsWith('rename from ')) ensureFile().fromPath = decodeGitPath(raw.slice(12));
    if (raw.startsWith('rename to ')) ensureFile().path = decodeGitPath(raw.slice(10));
  }
  for (const file of grouped) if (file.fromPath === file.path) delete file.fromPath;
  return grouped.filter((file) => file.lines.length > 0 || file.path);
}

export function countDiffLineStats(lines: readonly DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === 'add') additions += 1;
    else if (line.kind === 'del') deletions += 1;
  }
  return { additions, deletions };
}

export function diffFileBaseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function diffFileDisplayName(path: string, paths: readonly string[]): string {
  const base = diffFileBaseName(path) || path;
  const duplicates = paths.filter((item) => diffFileBaseName(item) === base).length > 1;
  return duplicates ? path : base;
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
