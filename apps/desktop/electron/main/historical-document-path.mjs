import path from 'node:path';

export const isGitDocumentRevision = value => !!value && typeof value === 'object' && value.kind === 'git'
  && typeof value.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.commit)
  && (value.repositoryId === undefined || typeof value.repositoryId === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.repositoryId));
const inside = (root, target) => { const rel = path.relative(root, target); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const failure = status => ({ ok: false, status, content: '', error: status });

/** Missing tree entries retain a scoped virtual locator; existing ancestors cannot escape. */
export function checkedHistoricalDocumentPath(target, scope, { realpath, stat }) {
  if (!scope || !inside(scope, target)) return failure('scope_denied');
  let ancestor = target;
  for (let depth = 0; depth < 256 && inside(scope, ancestor); depth++) {
    try {
      const physical = realpath(ancestor);
      if (!inside(scope, physical)) return failure('scope_denied');
      if (ancestor !== target && !stat(physical).isDirectory()) return failure('not_found');
      return { ok: true, root: scope, target, gitDirectory: ancestor === target ? path.dirname(target) : ancestor };
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error?.code)) return failure('permission_denied');
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return failure('invalid_path');
      if (ancestor === scope) return failure('workspace_unavailable');
      ancestor = path.dirname(ancestor);
    }
  }
  return failure('scope_denied');
}

/** Canonicalize an exact OS root alias without requiring the historical file to exist. */
export function historicalAliasTarget(target, realpath) {
  let ancestor = path.dirname(target);
  for (let depth = 0; depth < 256; depth++) {
    try { return path.resolve(realpath(ancestor), path.relative(ancestor, target)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || path.dirname(ancestor) === ancestor) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  throw Object.assign(new Error('historical_path_too_deep'), { code: 'EINVAL' });
}
