import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createWorkPanelGitRead } from '@peer-agent/runtime-node/git-read';

const ENTRY_LIMIT = 50;
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function inside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function openablePath(repoRoot, workspacePath, path) {
  // Paths are literal Git names; do not reinterpret separators or control characters.
  if (/[\\\x00-\x1f\x7f\uFFFD]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return undefined;
  const target = resolve(repoRoot, path);
  if (!inside(workspacePath, target)) return undefined;
  try {
    if (!inside(workspacePath, await realpath(target)) || !(await lstat(target)).isFile()) return undefined;
    return relative(workspacePath, target).split(sep).join('/');
  } catch { return undefined; }
}

function summarize({ repositoryPath: repoRoot, records, filtersDisabled, observedAt }) {
  let branch = null, headShort = null, unborn = false, detached = false;
  let stagedCount = 0, unstagedCount = 0, untrackedCount = 0, totalEntries = 0;
  const entries = [];
  for (const record of records.split('\0')) {
    if (record.startsWith('# branch.head ')) {
      const name = record.slice(14);
      detached = name === '(detached)';
      branch = detached ? null : name;
    } else if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      unborn = oid === '(initial)';
      if (!unborn) headShort = oid.slice(0, 8);
    } else {
      // Renames are disabled in the runner, so each NUL record is one path.
      const tracked = /^1 ([.A-Z]{2})(?: \S+){6} (.*)$/s.exec(record)
        ?? /^u ([A-Z]{2})(?: \S+){8} (.*)$/s.exec(record);
      const entry = record.startsWith('? ') ? { index: '?', worktree: '?', path: record.slice(2), conflicted: false }
        : tracked ? { index: tracked[1][0], worktree: tracked[1][1], path: tracked[2], conflicted: conflictCodes.has(tracked[1]) }
          : null;
      if (!entry?.path) continue;
      totalEntries++;
      if (entry.index === '?') untrackedCount++;
      else if (!entry.conflicted) {
        if (entry.index !== '.') stagedCount++;
        if (entry.worktree !== '.') unstagedCount++;
      }
      if (entries.length < ENTRY_LIMIT) entries.push(entry);
    }
  }
  return { kind: 'status', isGitRepo: true, repoRoot, branch, headShort, detached, unborn,
    clean: totalEntries ? false : filtersDisabled ? null : true, filtersDisabled,
    changedCount: totalEntries, stagedCount, unstagedCount, untrackedCount, entries,
    truncated: totalEntries > entries.length, totalEntries, observedAt };
}

export function createWorkPanelGitStatus({ resolveWorkspacePath,
  read = createWorkPanelGitRead({ timeoutMs: 3000, maxBytes: 512 * 1024 }) }) {
  const pending = new Map();

  async function observe(path) {
    // Desktop may observe the enclosing repo and linked-worktree metadata for a registered folder.
    const observation = await read({ path }, { authorize: async () => {} });
    const status = summarize(observation);
    status.entries = await Promise.all(status.entries.map(async entry => {
      const openPath = await openablePath(status.repoRoot, observation.workspacePath, entry.path);
      return openPath === undefined ? entry : { ...entry, openPath };
    }));
    return status;
  }

  function enqueue(path) {
    const active = pending.get(path);
    if (active) {
      // A task may have completed since the active observation began. Coalesce callers
      // onto one follow-up, not onto the potentially stale active result.
      return active.next ??= active.current.then(() => enqueue(path), () => enqueue(path));
    }
    const current = observe(path).finally(() => pending.delete(path));
    pending.set(path, { current });
    return current;
  }

  const unavailable = kind => ({ kind, isGitRepo: false, observedAt: new Date().toISOString() });
  return async function readGitStatus(payload) {
    const workspaceId = payload?.workspaceId;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1
      || !Object.hasOwn(payload, 'workspaceId') || typeof workspaceId !== 'string'
      || !workspaceId.trim() || workspaceId.length > 256 || /[\\/\x00-\x1f\x7f]/u.test(workspaceId)
      || workspaceId === '.' || workspaceId === '..') return unavailable('invalid-workspace');
    try {
      const path = resolveWorkspacePath(workspaceId);
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return unavailable('invalid-workspace');
      return await enqueue(path);
    } catch (error) {
      return unavailable(['git_not_repository', 'git_worktree_required'].includes(error?.reason) ? 'not-git' : 'unavailable');
    }
  };
}
