import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.peer-agent',
  '.next',
  '.turbo',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
]);

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_VISITED = 4000;
const DEFAULT_EMPTY_DEPTH = 2;

export function shouldSkipDirName(name) {
  if (!name) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  return name.startsWith('.');
}

export function shouldSkipFileName(name) {
  if (!name) return true;
  if (name === '.' || name === '..') return true;
  return name.startsWith('.') || isFinderPlaceholderName(name);
}

export function isFinderPlaceholderName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  return /^(新建文件|新建文件夹|未命名文件夹|未命名的文件夹|未命名|untitled(?: folder| file)?)$/iu.test(trimmed);
}

export function scoreWorkspaceFile(relPath, query) {
  const normalized = relPath.replaceAll('\\', '/');
  const fileName = path.posix.basename(normalized);
  const lowerPath = normalized.toLowerCase();
  const lowerName = fileName.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const depth = normalized.split('/').filter(Boolean).length;
    return Math.max(1, 20 - depth);
  }
  if (lowerName === needle) return 100;
  if (lowerName.startsWith(needle)) return 86;
  if (lowerName.includes(needle)) return 72;
  const segments = lowerPath.split('/');
  if (segments.some((segment) => segment.startsWith(needle))) return 58;
  if (lowerPath.includes(needle)) return 44;
  return 0;
}

export function rankWorkspaceFiles(entries, query, limit = DEFAULT_LIMIT) {
  const scored = [];
  for (const entry of entries) {
    const relPath = String(entry.relPath || '').replaceAll('\\', '/');
    if (!relPath) continue;
    const score = scoreWorkspaceFile(relPath, query);
    if (score <= 0) continue;
    scored.push({
      relPath,
      name: path.posix.basename(relPath),
      kind: entry.kind === 'directory' ? 'directory' : 'file',
      score,
    });
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.relPath.length !== right.relPath.length) return left.relPath.length - right.relPath.length;
    return left.relPath.localeCompare(right.relPath);
  });
  return scored.slice(0, Math.max(1, limit)).map(({ score: _score, ...hit }) => hit);
}

function collectWorkspaceFiles(workspaceRoot, {
  query = '',
  limit = DEFAULT_LIMIT,
  maxVisited = DEFAULT_MAX_VISITED,
  emptyDepth = DEFAULT_EMPTY_DEPTH,
} = {}) {
  const root = path.normalize(workspaceRoot);
  const needle = String(query || '').trim();
  const collected = [];
  const stack = [{ absPath: root, relPath: '', depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < maxVisited && collected.length < maxVisited) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.absPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxVisited) break;
      const name = entry.name;
      const childRel = current.relPath ? `${current.relPath}/${name}` : name;
      const childAbs = path.join(current.absPath, name);
      if (entry.isDirectory()) {
        if (shouldSkipDirName(name) || isFinderPlaceholderName(name)) continue;
        collected.push({ relPath: childRel, kind: 'directory' });
        if (!needle && current.depth >= emptyDepth) continue;
        stack.push({ absPath: childAbs, relPath: childRel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFileName(name)) continue;
      collected.push({ relPath: childRel, kind: 'file' });
    }
  }
  return rankWorkspaceFiles(collected, needle, limit);
}

export function searchWorkspaceFiles(workspaceRoot, options = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, status: 'invalid_path', files: [], error: 'missing_workspace' };
  }
  const normalized = path.normalize(workspaceRoot);
  if (!path.isAbsolute(normalized)) {
    return { ok: false, status: 'invalid_path', files: [], error: 'workspace_must_be_absolute' };
  }
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return { ok: false, status: 'not_dir', files: [], error: 'workspace_not_dir' };
    }
  } catch {
    return { ok: false, status: 'not_found', files: [], error: 'workspace_not_found' };
  }
  try {
    const files = collectWorkspaceFiles(normalized, options);
    return { ok: true, status: 'ok', files, workspacePath: normalized };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
