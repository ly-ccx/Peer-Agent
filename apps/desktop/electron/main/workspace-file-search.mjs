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

/** 文件树列出/监视要跳过的目录名。不含「所有点文件」，以免藏掉 .env / .gitignore。 */
export function isSkippedFileTreeDirName(name) {
  return Boolean(name) && SKIP_DIR_NAMES.has(name);
}

export function isSkippedFileTreePath(absPath) {
  const parts = String(absPath ?? '').split(/[/\\]/);
  return parts.some((part) => isSkippedFileTreeDirName(part));
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
  maxDepth = 32,
} = {}) {
  const root = path.normalize(workspaceRoot);
  const needle = String(query || '').trim();
  const collected = [];
  const stack = [{ absPath: root, relPath: '', depth: 0 }];
  let visited = 0;
  let truncated = false;

  while (stack.length > 0 && visited < maxVisited && collected.length < maxVisited) {
    const current = stack.pop();
    let directory;
    try {
      directory = fs.opendirSync(current.absPath);
    } catch (error) {
      if (current.depth === 0) throw error;
      truncated = true;
      continue;
    }
    try {
      let entry;
      while (visited < maxVisited && (entry = directory.readSync())) {
        visited += 1;
        const name = entry.name;
        const childRel = current.relPath ? `${current.relPath}/${name}` : name;
        const childAbs = path.join(current.absPath, name);
        if (entry.isDirectory()) {
          if (shouldSkipDirName(name) || isFinderPlaceholderName(name)) continue;
          collected.push({ relPath: childRel, kind: 'directory' });
          if (!needle && current.depth >= emptyDepth) continue;
          if (current.depth >= maxDepth) { truncated = true; continue; }
          stack.push({ absPath: childAbs, relPath: childRel, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        if (shouldSkipFileName(name)) continue;
        collected.push({ relPath: childRel, kind: 'file' });
      }
      if (visited >= maxVisited) truncated = true;
    } catch { truncated = true; }
    finally { try { directory.closeSync(); } catch { /* Already closed/unavailable. */ } }
  }
  const ranked = rankWorkspaceFiles(collected, needle, collected.length || 1);
  return { files: ranked.slice(0, limit), visited, truncated: truncated || stack.length > 0 || ranked.length > limit };
}

export function searchWorkspaceFiles(workspaceRoot, options = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, status: 'invalid_path', files: [], error: 'missing_workspace' };
  }
  const normalized = path.normalize(workspaceRoot);
  if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 256)) {
    return { ok: false, status: 'invalid_path', files: [], error: 'invalid_query' };
  }
  if (!path.isAbsolute(normalized)) {
    return { ok: false, status: 'invalid_path', files: [], error: 'workspace_must_be_absolute' };
  }
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return { ok: false, status: 'not_dir', files: [], error: 'workspace_not_dir' };
    }
  } catch (error) {
    const denied = error?.code === 'EACCES' || error?.code === 'EPERM';
    return { ok: false, status: denied ? 'permission_denied' : 'not_found', files: [], error: denied ? 'workspace_not_readable' : 'workspace_not_found' };
  }
  try {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(40, Math.floor(options.limit))) : DEFAULT_LIMIT;
    const maxVisited = Number.isFinite(options.maxVisited) ? Math.max(1, Math.min(DEFAULT_MAX_VISITED, Math.floor(options.maxVisited))) : DEFAULT_MAX_VISITED;
    const result = collectWorkspaceFiles(normalized, { ...options, limit, maxVisited, maxDepth: 32 });
    return { ok: true, status: 'ok', ...result, workspacePath: normalized };
  } catch (error) {
    return {
      ok: false,
      status: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission_denied' : 'error',
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
