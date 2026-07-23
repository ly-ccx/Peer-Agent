import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const SEARCH_MAX_FILE_BYTES = 1_000_000;
export const SEARCH_DEFAULT_MAX_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 200;

export interface NodeFileSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface NodeFileSearchRequest {
  readonly workspaceRoot: string;
  readonly targetPath: string;
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface NodeFileSearchResult {
  readonly matches: readonly NodeFileSearchMatch[];
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly maxResults: number;
}

function displayPath(workspaceRoot: string, targetPath: string): string {
  const path = relative(workspaceRoot, targetPath);
  return path || '.';
}

async function collectSearchFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  if (!rootStat.isDirectory()) throw new Error('not_a_file_or_directory');

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    if (signal?.aborted) throw new Error('aborted');
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files.sort();
}

export function normalizeSearchMaxResults(value: unknown): number {
  const requested = typeof value === 'number'
    ? Math.floor(value)
    : SEARCH_DEFAULT_MAX_RESULTS;
  return Math.min(SEARCH_MAX_RESULTS, Math.max(1, requested));
}

export async function runNodeFileSearch(
  request: NodeFileSearchRequest,
): Promise<NodeFileSearchResult> {
  const maxResults = normalizeSearchMaxResults(request.maxResults);
  const caseSensitive = request.caseSensitive === true;
  const needle = caseSensitive ? request.query : request.query.toLocaleLowerCase();
  const matches: NodeFileSearchMatch[] = [];
  const files = await collectSearchFiles(request.targetPath, request.signal);

  for (const filePath of files) {
    if (request.signal?.aborted) throw new Error('aborted');
    if (matches.length >= maxResults) break;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > SEARCH_MAX_FILE_BYTES) continue;
      const content = await readFile(filePath, 'utf8');
      if (content.includes('\0')) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        if (haystack.includes(needle)) {
          matches.push({
            path: displayPath(request.workspaceRoot, filePath),
            line: index + 1,
            text: line,
          });
        }
        if (matches.length >= maxResults) break;
      }
    } catch {
      // Unreadable entries are skipped, matching the existing single-search behavior.
    }
  }

  return {
    matches,
    matchCount: matches.length,
    truncated: matches.length >= maxResults,
    maxResults,
  };
}
