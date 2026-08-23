import path from 'node:path';
import { searchWorkspaceFiles } from './workspace-file-search.mjs';

const DEFAULT_MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
/** Chat image preview: same ceiling as renderer attachment intake (8 MiB). */
const DEFAULT_MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
});

function imageMimeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] || null;
}

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function sanitizeRelativePath(value) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/^[/\\]+/, '').replace(/^(\.\.?[/\\])+/, '')
    : '';
}

function workspacePaths(settings, workspaceRoot, includeWorkspaceRoot = true) {
  const candidates = [
    ...(settings.workspaces || []).map((workspace) => (
      workspace && typeof workspace === 'object' ? workspace.path : workspace
    )),
    settings.activeWorkspace,
    ...(includeWorkspaceRoot ? [workspaceRoot] : []),
  ].filter((candidate) => typeof candidate === 'string' && candidate);
  return [...new Set(candidates)];
}

function closeWatcher(watcher) {
  try {
    watcher.close();
  } catch {
    // Cleanup remains best-effort and idempotent.
  }
}

export function createFileAccessApplicationService(options = {}) {
  const getSettings = assertFunction(options.getSettings, 'getSettings');
  const pathExists = assertFunction(options.pathExists, 'pathExists');
  const statPath = assertFunction(options.statPath, 'statPath');
  const readDirectoryEntries = assertFunction(options.readDirectory, 'readDirectory');
  const readFileBuffer = assertFunction(options.readFile, 'readFile');
  const writeFileContent = assertFunction(options.writeFile, 'writeFile');
  const createDirectory = assertFunction(options.createDirectory, 'createDirectory');
  const watchDirectory = assertFunction(options.watchDirectory, 'watchDirectory');
  const executeGit = assertFunction(options.executeGit, 'executeGit');
  const maxTextFileBytes = options.maxTextFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES;
  const watchersBySender = new Map();

  function recoverPath(absPath, relPath, workspaceRoot, includeWorkspaceRoot = true) {
    let target = path.normalize(absPath);
    if (pathExists(target)) return { target, resolvedFrom: undefined };

    const cleanRel = sanitizeRelativePath(relPath);
    if (!cleanRel) return null;
    const candidates = workspacePaths(
      getSettings(),
      workspaceRoot,
      includeWorkspaceRoot,
    );
    for (const workspacePath of candidates) {
      const candidate = path.normalize(path.join(workspacePath, cleanRel));
      if (pathExists(candidate)) {
        return { target: candidate, resolvedFrom: workspacePath };
      }
    }
    return null;
  }

  /**
   * 解析「尚未存在」的写入目标路径。
   * 优先复用已存在路径；否则要求绝对路径，并在 parent 不存在时用 workspace+relPath 回退。
   */
  function resolveCreateTarget(absPath, relPath, workspaceRoot) {
    if (!absPath || typeof absPath !== 'string') return null;
    const normalized = path.normalize(absPath);
    if (!path.isAbsolute(normalized)) return null;

    const existing = recoverPath(normalized, relPath, workspaceRoot);
    if (existing) return existing;

    const parent = path.dirname(normalized);
    if (pathExists(parent)) {
      return { target: normalized, resolvedFrom: undefined };
    }

    const cleanRel = sanitizeRelativePath(relPath);
    if (!cleanRel) return null;
    const candidates = workspacePaths(getSettings(), workspaceRoot, true);
    for (const workspacePath of candidates) {
      const candidate = path.normalize(path.join(workspacePath, cleanRel));
      const candidateParent = path.dirname(candidate);
      if (pathExists(candidateParent) || pathExists(workspacePath)) {
        return { target: candidate, resolvedFrom: workspacePath };
      }
    }
    return null;
  }

  async function getGitDiff({ absPath, workspaceRoot, relPath } = {}) {
    try {
      if (!absPath || typeof absPath !== 'string') {
        return { ok: false, status: 'invalid_path', diffText: '', error: 'invalid_path' };
      }
      const normalized = path.normalize(absPath);
      if (!path.isAbsolute(normalized)) {
        return { ok: false, status: 'invalid_path', diffText: '', error: 'not_absolute' };
      }
      const recovered = recoverPath(normalized, relPath, undefined, false);
      if (!recovered) {
        return { ok: false, status: 'not_found', diffText: '', error: 'file_not_found' };
      }
      const { target, resolvedFrom } = recovered;
      const cwd = resolvedFrom || (
        workspaceRoot && typeof workspaceRoot === 'string' && pathExists(workspaceRoot)
          ? workspaceRoot
          : path.dirname(target)
      );

      let repoRoot;
      try {
        const { stdout } = await executeGit(
          cwd,
          ['rev-parse', '--show-toplevel'],
          { maxBuffer: 1024 * 1024 * 16 },
        );
        repoRoot = stdout.trim();
      } catch {
        return {
          ok: false,
          status: 'not_git_repo',
          diffText: '',
          error: 'not_a_git_repository',
        };
      }

      const repoRelPath = path.relative(repoRoot, target);
      let tracked = true;
      try {
        await executeGit(
          repoRoot,
          ['ls-files', '--error-unmatch', '--', repoRelPath],
          { maxBuffer: 1024 * 1024 * 16 },
        );
      } catch {
        tracked = false;
      }

      const runGit = async (args) => {
        try {
          const { stdout } = await executeGit(
            repoRoot,
            args,
            { maxBuffer: 1024 * 1024 * 32 },
          );
          return stdout;
        } catch (error) {
          if (error && typeof error.stdout === 'string' && error.stdout.length > 0) {
            return error.stdout;
          }
          throw error;
        }
      };

      if (!tracked) {
        const diffText = await runGit(['diff', '--no-index', '--', '/dev/null', target]);
        return {
          ok: true,
          status: diffText.trim() ? 'untracked' : 'no_changes',
          diffText,
          resolvedFrom,
        };
      }

      let diffText = await runGit(['diff', '--', repoRelPath]);
      if (diffText.trim()) {
        return { ok: true, status: 'modified', diffText, resolvedFrom };
      }
      diffText = await runGit(['diff', '--staged', '--', repoRelPath]);
      if (diffText.trim()) {
        return { ok: true, status: 'staged', diffText, resolvedFrom };
      }
      try {
        diffText = await runGit(['diff', 'HEAD~1', 'HEAD', '--', repoRelPath]);
        if (diffText.trim()) {
          return { ok: true, status: 'last_commit', diffText, resolvedFrom };
        }
      } catch {
        // Repositories with no HEAD~1 legitimately fall through to no_changes.
      }
      return { ok: true, status: 'no_changes', diffText: '', resolvedFrom };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        diffText: '',
        error: error?.message || String(error),
      };
    }
  }

  function isSafeGitRef(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 255) return false;
    if (trimmed.startsWith('-') || /\s/.test(trimmed) || trimmed.includes('..') || trimmed.includes(':')) {
      return false;
    }
    return /^[A-Za-z0-9._/@~^+-]+$/.test(trimmed);
  }

  async function resolveRepoRoot(workspaceRoot) {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') return null;
    const normalized = path.normalize(workspaceRoot);
    if (!path.isAbsolute(normalized) || !pathExists(normalized)) return null;
    try {
      const { stdout } = await executeGit(
        normalized,
        ['rev-parse', '--show-toplevel'],
        { maxBuffer: 1024 * 1024 },
      );
      const repoRoot = stdout.trim();
      return repoRoot || null;
    } catch {
      return null;
    }
  }

  async function getGitRangeDiff({ workspaceRoot, fromRef, toRef } = {}) {
    if (!isSafeGitRef(fromRef)) {
      return { ok: false, status: 'invalid_ref', diffText: '', error: 'invalid_ref' };
    }
    const endRef = typeof toRef === 'string' && toRef.trim() ? toRef.trim() : null;
    if (endRef && !isSafeGitRef(endRef)) {
      return { ok: false, status: 'invalid_ref', diffText: '', error: 'invalid_ref' };
    }
    const repoRoot = await resolveRepoRoot(workspaceRoot);
    if (!repoRoot) {
      return { ok: false, status: 'not_git_repo', diffText: '', error: 'not_a_git_repository' };
    }
    const args = endRef
      ? ['diff', '--no-color', fromRef.trim(), endRef]
      : ['diff', '--no-color', fromRef.trim()];
    try {
      const { stdout } = await executeGit(repoRoot, args, { maxBuffer: 1024 * 1024 * 32 });
      const diffText = stdout || '';
      return {
        ok: true,
        status: diffText.trim() ? 'ok' : 'no_changes',
        diffText,
        fromRef: fromRef.trim(),
        toRef: endRef,
      };
    } catch (error) {
      if (error && typeof error.stdout === 'string' && error.stdout.length > 0) {
        return {
          ok: true,
          status: 'ok',
          diffText: error.stdout,
          fromRef: fromRef.trim(),
          toRef: endRef,
        };
      }
      return {
        ok: false,
        status: 'error',
        diffText: '',
        error: error?.message || String(error),
        fromRef: fromRef.trim(),
        toRef: endRef,
      };
    }
  }

  async function listGitBranches({ workspaceRoot } = {}) {
    const repoRoot = await resolveRepoRoot(workspaceRoot);
    if (!repoRoot) {
      return { ok: false, branches: [], current: null, error: 'not_a_git_repository' };
    }
    try {
      const { stdout: currentOut } = await executeGit(
        repoRoot,
        ['branch', '--show-current'],
        { maxBuffer: 1024 * 1024 },
      );
      const { stdout: listOut } = await executeGit(
        repoRoot,
        ['branch', '--format=%(refname:short)'],
        { maxBuffer: 1024 * 1024 },
      );
      const current = currentOut.trim() || null;
      const branches = [...new Set(
        String(listOut || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      )];
      return { ok: true, branches, current, repoRoot };
    } catch (error) {
      return {
        ok: false,
        branches: [],
        current: null,
        error: error?.message || String(error),
      };
    }
  }

  function exists({ absPath, workspaceRoot, relPath } = {}) {
    try {
      if (!absPath || typeof absPath !== 'string') return { exists: false };
      const normalized = path.normalize(absPath);
      if (!path.isAbsolute(normalized)) return { exists: false };
      const recovered = recoverPath(normalized, relPath, workspaceRoot);
      if (!recovered) return { exists: false };
      const stat = statPath(recovered.target);
      return recovered.resolvedFrom
        ? {
            exists: true,
            isDir: stat.isDirectory(),
            resolvedFrom: recovered.resolvedFrom,
          }
        : { exists: true, isDir: stat.isDirectory() };
    } catch {
      return { exists: false };
    }
  }

  function readDirectory({ absPath, workspaceRoot, relPath } = {}) {
    try {
      if (!absPath || typeof absPath !== 'string') {
        return { ok: false, status: 'invalid_path', entries: [], error: 'invalid_path' };
      }
      const normalized = path.normalize(absPath);
      if (!path.isAbsolute(normalized)) {
        return { ok: false, status: 'invalid_path', entries: [], error: 'not_absolute' };
      }
      const recovered = recoverPath(normalized, relPath, workspaceRoot);
      if (!recovered) {
        return { ok: false, status: 'not_found', entries: [], error: 'dir_not_found' };
      }
      const { target, resolvedFrom } = recovered;
      let stat;
      try {
        stat = statPath(target);
      } catch {
        return {
          ok: false,
          status: 'not_found',
          entries: [],
          error: 'stat_failed',
        };
      }
      if (!stat.isDirectory()) {
        return {
          ok: false,
          status: 'not_dir',
          entries: [],
          resolvedFrom,
          error: 'not_a_directory',
        };
      }
      const entries = readDirectoryEntries(target)
        .map((entry) => ({
          name: entry.name,
          isDir: entry.isDirectory(),
          absPath: path.join(target, entry.name),
        }))
        .sort((left, right) => {
          if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' });
        });
      return { ok: true, status: 'ok', entries, resolvedFrom };
    } catch {
      return { ok: false, status: 'error', entries: [], error: 'read_dir_failed' };
    }
  }

  function stopSenderWatchers(senderId) {
    const watchers = watchersBySender.get(senderId);
    if (!watchers) return;
    for (const watcher of watchers.values()) closeWatcher(watcher);
    watchersBySender.delete(senderId);
  }

  function resolveWatchDirectory(absPath, workspaceRoot) {
    if (!absPath || typeof absPath !== 'string') return null;
    try {
      if (pathExists(absPath) && statPath(absPath).isDirectory()) return absPath;
    } catch {
      // Fall through to workspace-root resolution.
    }
    if (typeof workspaceRoot === 'string' && workspaceRoot) {
      try {
        const candidate = path.isAbsolute(absPath)
          ? absPath
          : path.join(workspaceRoot, absPath);
        if (pathExists(candidate) && statPath(candidate).isDirectory()) return candidate;
      } catch {
        // Invalid or inaccessible candidates are skipped.
      }
    }
    return null;
  }

  function watchDirectories(sender, { paths, workspaceRoot } = {}) {
    const senderId = sender.id;
    const requested = Array.isArray(paths)
      ? paths.filter((candidate) => typeof candidate === 'string' && candidate.trim())
      : [];

    if (!watchersBySender.has(senderId)) {
      watchersBySender.set(senderId, new Map());
      sender.once('destroyed', () => stopSenderWatchers(senderId));
    }
    const current = watchersBySender.get(senderId);
    const desired = new Map();
    for (const rawPath of requested) {
      const resolvedPath = resolveWatchDirectory(rawPath, workspaceRoot);
      if (resolvedPath) desired.set(resolvedPath, true);
    }

    for (const [dirPath, watcher] of current.entries()) {
      if (!desired.has(dirPath)) {
        closeWatcher(watcher);
        current.delete(dirPath);
      }
    }

    for (const dirPath of desired.keys()) {
      if (current.has(dirPath)) continue;
      try {
        const watcher = watchDirectory(dirPath, { persistent: false }, () => {
          if (sender.isDestroyed()) return;
          sender.send('fs:dir-changed', { dirPath });
        });
        if (typeof watcher?.on === 'function') {
          watcher.on('error', () => {
            closeWatcher(watcher);
            current.delete(dirPath);
          });
        }
        current.set(dirPath, watcher);
      } catch {
        // A path may disappear between validation and watcher creation.
      }
    }

    return { ok: true, watching: [...current.keys()] };
  }

  async function readFile({ absPath, workspaceRoot, relPath } = {}) {
    try {
      if (!absPath || typeof absPath !== 'string') {
        return { ok: false, status: 'invalid_path', content: '', error: 'invalid_path' };
      }
      const normalized = path.normalize(absPath);
      if (!path.isAbsolute(normalized)) {
        return { ok: false, status: 'invalid_path', content: '', error: 'not_absolute' };
      }
      const recovered = recoverPath(normalized, relPath, workspaceRoot);
      if (!recovered) {
        return { ok: false, status: 'not_found', content: '', error: 'file_not_found' };
      }
      const { target, resolvedFrom } = recovered;
      let stat;
      try {
        stat = statPath(target);
      } catch {
        return { ok: false, status: 'not_found', content: '', error: 'stat_failed' };
      }
      if (!stat.isFile()) {
        return {
          ok: false,
          status: 'not_file',
          content: '',
          error: 'not_a_file',
          resolvedFrom,
        };
      }
      if (stat.size > maxTextFileBytes) {
        return {
          ok: false,
          status: 'too_large',
          content: '',
          size: stat.size,
          resolvedFrom,
          error: 'file_too_large',
        };
      }
      const buffer = readFileBuffer(target);
      const sniffLength = Math.min(buffer.length, 8192);
      for (let index = 0; index < sniffLength; index += 1) {
        if (buffer[index] === 0) {
          return {
            ok: false,
            status: 'binary',
            content: '',
            size: stat.size,
            resolvedFrom,
            error: 'binary_file',
          };
        }
      }
      return {
        ok: true,
        status: 'ok',
        content: buffer.toString('utf8'),
        size: stat.size,
        resolvedFrom,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        content: '',
        error: error?.message || 'read_failed',
      };
    }
  }

  /**
   * 新建空文件。仅允许在已存在父目录下创建；不覆盖已有文件。
   */
  function writeFile({ absPath, workspaceRoot, relPath, content = '' } = {}) {
    try {
      const resolved = resolveCreateTarget(absPath, relPath, workspaceRoot);
      if (!resolved) {
        return { ok: false, status: 'invalid_path', error: 'invalid_path' };
      }
      const { target, resolvedFrom } = resolved;
      if (pathExists(target)) {
        return {
          ok: false,
          status: 'already_exists',
          error: 'path_already_exists',
          path: target,
          resolvedFrom,
        };
      }
      const parent = path.dirname(target);
      if (!pathExists(parent)) {
        return {
          ok: false,
          status: 'not_found',
          error: 'parent_not_found',
          path: target,
          resolvedFrom,
        };
      }
      try {
        if (!statPath(parent).isDirectory()) {
          return {
            ok: false,
            status: 'not_dir',
            error: 'parent_not_dir',
            path: target,
            resolvedFrom,
          };
        }
      } catch {
        return {
          ok: false,
          status: 'not_found',
          error: 'parent_stat_failed',
          path: target,
          resolvedFrom,
        };
      }
      const text = typeof content === 'string' ? content : '';
      writeFileContent(target, text);
      return resolvedFrom
        ? { ok: true, status: 'ok', path: target, resolvedFrom }
        : { ok: true, status: 'ok', path: target };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        error: error?.message || String(error),
      };
    }
  }

  /**
   * 新建文件夹。仅允许在已存在父目录下创建；不覆盖已有路径。
   */
  function mkdir({ absPath, workspaceRoot, relPath } = {}) {
    try {
      const resolved = resolveCreateTarget(absPath, relPath, workspaceRoot);
      if (!resolved) {
        return { ok: false, status: 'invalid_path', error: 'invalid_path' };
      }
      const { target, resolvedFrom } = resolved;
      if (pathExists(target)) {
        return {
          ok: false,
          status: 'already_exists',
          error: 'path_already_exists',
          path: target,
          resolvedFrom,
        };
      }
      const parent = path.dirname(target);
      if (!pathExists(parent)) {
        return {
          ok: false,
          status: 'not_found',
          error: 'parent_not_found',
          path: target,
          resolvedFrom,
        };
      }
      try {
        if (!statPath(parent).isDirectory()) {
          return {
            ok: false,
            status: 'not_dir',
            error: 'parent_not_dir',
            path: target,
            resolvedFrom,
          };
        }
      } catch {
        return {
          ok: false,
          status: 'not_found',
          error: 'parent_stat_failed',
          path: target,
          resolvedFrom,
        };
      }
      createDirectory(target);
      return resolvedFrom
        ? { ok: true, status: 'ok', path: target, resolvedFrom }
        : { ok: true, status: 'ok', path: target };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        error: error?.message || String(error),
      };
    }
  }

  function readImageDataUrl({ absPath, workspaceRoot, relPath } = {}) {
    try {
      if (!absPath || typeof absPath !== 'string') {
        return { ok: false, status: 'invalid_path', dataUrl: '', error: 'invalid_path' };
      }
      const normalized = path.normalize(absPath);
      if (!path.isAbsolute(normalized)) {
        return { ok: false, status: 'invalid_path', dataUrl: '', error: 'not_absolute' };
      }
      const resolved = recoverPath(normalized, relPath, workspaceRoot);
      if (!resolved) {
        return { ok: false, status: 'not_found', dataUrl: '', error: 'file_not_found' };
      }
      const { target, resolvedFrom } = resolved;
      let stat;
      try {
        stat = statPath(target);
      } catch {
        return { ok: false, status: 'not_found', dataUrl: '', error: 'stat_failed' };
      }
      if (!stat.isFile()) {
        return {
          ok: false,
          status: 'not_file',
          dataUrl: '',
          error: 'not_a_file',
          resolvedFrom,
        };
      }
      const mimeType = imageMimeFromPath(target);
      if (!mimeType) {
        return {
          ok: false,
          status: 'unsupported_type',
          dataUrl: '',
          error: 'not_an_image',
          resolvedFrom,
        };
      }
      if (stat.size > DEFAULT_MAX_IMAGE_FILE_BYTES) {
        return {
          ok: false,
          status: 'too_large',
          dataUrl: '',
          error: 'file_too_large',
          size: stat.size,
          resolvedFrom,
        };
      }
      const buffer = readFileBuffer(target);
      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      return resolvedFrom
        ? {
            ok: true,
            status: 'ok',
            dataUrl,
            mimeType,
            size: buffer.length,
            path: target,
            resolvedFrom,
          }
        : {
            ok: true,
            status: 'ok',
            dataUrl,
            mimeType,
            size: buffer.length,
            path: target,
          };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        dataUrl: '',
        error: error?.message || String(error),
      };
    }
  }

  function dispose() {
    for (const senderId of [...watchersBySender.keys()]) stopSenderWatchers(senderId);
  }

  return Object.freeze({
    getGitDiff,
    getGitRangeDiff,
    listGitBranches,
    exists,
    readDirectory,
    watchDirectories,
    readFile,
    readImageDataUrl,
    writeFile,
    mkdir,
    searchWorkspaceFiles: ({ workspacePath, query, limit } = {}) => (
      searchWorkspaceFiles(workspacePath, { query, limit })
    ),
    dispose,
  });
}
