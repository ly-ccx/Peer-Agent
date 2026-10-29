import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceHead } from '../goal-delivery-binding.mjs';

/** Hash authority for memory validity; neither file contents nor model-supplied hashes escape this seam. */
export function createMemoryFileAnchors({ resolveWorkspacePath, readHead = resolveWorkspaceHead } = {}) {
  function read({ workspaceId, path: relativePath } = {}) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) return null;
    try {
      const root = realpathSync(resolveWorkspacePath(workspaceId)), file = realpathSync(path.resolve(root, relativePath));
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const stat = statSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      const bytes = readFileSync(file); if (bytes.length > 1024 * 1024) return null;
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      return { path: relative.split(path.sep).join('/'), contentHash, commit: readHead(root)?.commit || null };
    } catch { return null; }
  }
  function capture(workspaceId, paths = []) {
    return [...new Set(paths)].slice(0, 16).map(relativePath => read({ workspaceId, path: relativePath })).filter(Boolean);
  }
  return { read, capture };
}
