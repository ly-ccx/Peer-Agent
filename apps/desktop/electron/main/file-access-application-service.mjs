import path from 'node:path';
import { documentIdentity, observeDocumentRead, validExpectedObservation } from './document-observation.mjs';
import { createGitDocumentReader } from './git-document-reader.mjs';
import { isSkippedFileTreeDirName, isSkippedFileTreePath, searchWorkspaceFiles } from './workspace-file-search.mjs';

const DEFAULT_MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
/** Chat image preview: same ceiling as renderer attachment intake (8 MiB). */
const DEFAULT_MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

const PACKAGED_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.odt', '.ods']);
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
  const readGitDocument = createGitDocumentReader({ resolveBotDocument: options.resolveBotDocument, executeGit,
    maxTextFileBytes, maxImageFileBytes: DEFAULT_MAX_IMAGE_FILE_BYTES, imageMimeFromPath });
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

  async function getGitDiff({ absPath, workspaceRoot, relPath, documentReference, comparison } = {}) {
    try {
      if (documentReference?.revision !== undefined) return { ok: false, status: 'invalid_path', diffText: '', error: 'historical_document_not_live_diff' };
      if (comparison !== undefined && !['working', 'staged'].includes(comparison)) return { ok: false, status: 'invalid_path', diffText: '', error: 'invalid_comparison' };
      if (documentReference !== undefined) {
        const resolved = await options.resolveBotDocument?.({ ...documentReference, kind: 'file' });
        if (!resolved?.ok) return { ...resolved, ok: false, status: resolved?.status ?? 'invalid_path', diffText: '' };
        const result = await getGitDiff({ absPath: resolved.target, workspaceRoot: resolved.root, comparison });
        return { ...result, resolvedPath: resolved.target, resolvedFrom: resolved.root };
      }
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
      const literalRepoPath = `:(literal)${repoRelPath}`;
      let tracked = true;
      try {
        await executeGit(
          repoRoot,
          ['ls-files', '--error-unmatch', '--', literalRepoPath],
          { maxBuffer: 1024 * 1024 * 16 },
        );
      } catch {
        tracked = false;
      }

      const runGit = async (args) => {
        if (args[0] === 'diff') args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...args.slice(1)];
        try {
          const { stdout } = await executeGit(
            repoRoot,
            args,
            { maxBuffer: 1024 * 1024 * 32 },
          );
          return stdout;
        } catch (error) {
          if (error?.code === 1 && args.includes('--no-index') && typeof error.stdout === 'string' && error.stdout.length > 0) {
            return error.stdout;
          }
          throw error;
        }
      };

      if (!tracked) {
        if (comparison === 'staged') return { ok: true, status: 'no_changes', diffText: '', resolvedFrom };
        const diffText = await runGit(['diff', '--no-index', '--', '/dev/null', target]);
        return {
          ok: true,
          status: diffText.trim() ? 'untracked' : 'no_changes',
          diffText,
          resolvedFrom,
        };
      }

      if (comparison === 'staged') {
        const diffText = await runGit(['diff', '--staged', '--', literalRepoPath]);
        return { ok: true, status: diffText.trim() ? 'staged' : 'no_changes', diffText, resolvedFrom };
      }
      let diffText = await runGit(['diff', '--', literalRepoPath]);
      if (diffText.trim()) {
        return { ok: true, status: 'modified', diffText, resolvedFrom };
      }
      if (comparison === 'working') return { ok: true, status: 'no_changes', diffText: '', resolvedFrom };
      diffText = await runGit(['diff', '--staged', '--', literalRepoPath]);
      if (diffText.trim()) {
        return { ok: true, status: 'staged', diffText, resolvedFrom };
      }
      try {
        diffText = await runGit(['diff', 'HEAD~1', 'HEAD', '--', literalRepoPath]);
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

  async function getGitRangeDiff({ workspaceRoot, fromRef, toRef, documentReference, comparison } = {}) {
    let scopedRoot;
    if (documentReference !== undefined) {
      const resolved = await options.resolveBotDocument?.({ ...documentReference, kind: 'directory' });
      if (!resolved?.ok) return { ok: false, status: 'error', diffText: '', error: resolved?.status ?? 'workspace_unavailable' };
      scopedRoot = resolved.target;
      workspaceRoot = scopedRoot;
    }
    if (comparison !== undefined && !['working', 'staged'].includes(comparison)) {
      return { ok: false, status: 'invalid_ref', diffText: '', error: 'invalid_comparison' };
    }
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
    let resolvedBase = fromRef.trim(), resolvedEnd = endRef;
    if (scopedRoot && !comparison) {
      try {
        resolvedBase = (await executeGit(repoRoot, ['rev-parse', '--verify', `${fromRef.trim()}^{commit}`], { maxBuffer: 1024 * 1024 })).stdout.trim();
        if (endRef) resolvedEnd = (await executeGit(repoRoot, ['rev-parse', '--verify', `${endRef}^{commit}`], { maxBuffer: 1024 * 1024 })).stdout.trim();
      } catch { return { ok: false, status: 'invalid_ref', diffText: '', error: 'revision_unavailable' }; }
    }
    const args = comparison === 'working' ? ['diff', '--no-color'] : comparison === 'staged' ? ['diff', '--no-color', '--staged'] : resolvedEnd
      ? ['diff', '--no-color', resolvedBase, resolvedEnd]
      : ['diff', '--no-color', resolvedBase];
    const scopeRel = scopedRoot ? path.relative(repoRoot, scopedRoot) : null;
    if (scopeRel && (scopeRel === '..' || scopeRel.startsWith(`..${path.sep}`) || path.isAbsolute(scopeRel))) {
      return { ok: false, status: 'error', diffText: '', error: 'scope_denied' };
    }
    args.splice(1, 0, '--no-ext-diff', '--no-textconv');
    if (scopedRoot) args.push('--', scopeRel ? `:(literal)${scopeRel}` : '.');
    try {
      let untracked;
      let untrackedTruncated = false;
      if (scopedRoot && comparison === 'working') {
        const listed = await executeGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', scopeRel ? `:(literal)${scopeRel}` : '.'], { maxBuffer: 1024 * 1024 });
        const names = (listed.stdout || '').split('\0').filter(Boolean);
        untracked = names.slice(0, 512).map(name => path.join(repoRoot, name));
        untrackedTruncated = names.length > 512;
      }
      const { stdout } = await executeGit(repoRoot, args, { maxBuffer: 1024 * 1024 * 32 });
      const diffText = stdout || '';
      return {
        ok: true,
        status: diffText.trim() ? 'ok' : 'no_changes',
        diffText,
        fromRef: resolvedBase,
        toRef: resolvedEnd,
        workspaceRoot: repoRoot,
        ...(scopedRoot ? { resolvedPath: scopedRoot } : {}),
        ...(untracked ? { untracked, untrackedTruncated } : {}),
      };
    } catch (error) {
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

  function parseGitRefLines(stdout) {
    return [...new Set(
      String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )];
  }

  async function listGitBranches({ workspaceRoot } = {}) {
    const repoRoot = await resolveRepoRoot(workspaceRoot);
    if (!repoRoot) {
      return { ok: false, branches: [], localBranches: [], remoteBranches: [], current: null, error: 'not_a_git_repository' };
    }
    try {
      const { stdout: currentOut } = await executeGit(
        repoRoot,
        ['branch', '--show-current'],
        { maxBuffer: 1024 * 1024 },
      );
      const { stdout: localOut } = await executeGit(
        repoRoot,
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
        { maxBuffer: 1024 * 1024 },
      );
      const { stdout: remoteOut } = await executeGit(
        repoRoot,
        ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
        { maxBuffer: 1024 * 1024 },
      );
      const current = currentOut.trim() || null;
      const localBranches = parseGitRefLines(localOut);
      const remoteBranches = parseGitRefLines(remoteOut)
        .filter((name) => !name.endsWith('/HEAD'));
      const branches = [...new Set([...localBranches, ...remoteBranches])];
      return { ok: true, branches, localBranches, remoteBranches, current, repoRoot };
    } catch (error) {
      return {
        ok: false,
        branches: [],
        localBranches: [],
        remoteBranches: [],
        current: null,
        error: error?.message || String(error),
      };
    }
  }

  async function createGitBranch({
    workspaceRoot,
    name,
    startPoint,
    push,
    upstreamRemote,
    upstreamBranch,
  } = {}) {
    const branchName = typeof name === 'string' ? name.trim() : '';
    if (!isSafeGitRef(branchName)) {
      return { ok: false, status: 'invalid_name', current: null, error: 'invalid_branch_name' };
    }
    const fromRef = typeof startPoint === 'string' ? startPoint.trim() : '';
    if (fromRef && !isSafeGitRef(fromRef)) {
      return { ok: false, status: 'invalid_ref', current: null, error: 'invalid_ref' };
    }
    let pushRemote = '';
    let pushBranch = '';
    if (push === true) {
      pushRemote = typeof upstreamRemote === 'string' ? upstreamRemote.trim() : '';
      pushBranch = typeof upstreamBranch === 'string' ? upstreamBranch.trim() : '';
      if (!pushBranch) pushBranch = branchName;
      if (pushRemote && !isSafeGitRef(pushRemote)) {
        return { ok: false, status: 'invalid_name', current: null, error: 'invalid_upstream' };
      }
      if (!isSafeGitRef(pushBranch)) {
        return { ok: false, status: 'invalid_name', current: null, error: 'invalid_upstream' };
      }
    }
    const repoRoot = await resolveRepoRoot(workspaceRoot);
    if (!repoRoot) {
      return { ok: false, status: 'not_git_repo', current: null, error: 'not_a_git_repository' };
    }
    let pushResult = { pushed: false, pushError: null };
    try {
      const args = fromRef
        ? ['branch', '--', branchName, fromRef]
        : ['branch', '--', branchName];
      await executeGit(repoRoot, args, { maxBuffer: 1024 * 1024 });
      const { stdout: currentOut } = await executeGit(
        repoRoot,
        ['branch', '--show-current'],
        { maxBuffer: 1024 * 1024 },
      );
      if (push === true) {
        pushResult = await pushGitBranch(repoRoot, branchName, pushRemote, pushBranch);
      }
      return {
        ok: true,
        status: 'created',
        name: branchName,
        current: currentOut.trim() || null,
        repoRoot,
        ...pushResult,
      };
    } catch (error) {
      const message = error?.message || String(error);
      const alreadyExists = /already exists/i.test(message);
      return {
        ok: false,
        status: alreadyExists ? 'already_exists' : 'error',
        current: null,
        error: alreadyExists ? 'branch_already_exists' : message,
      };
    }
  }

  /**
   * Push a freshly created branch with upstream tracking (`git push -u`).
   * The refspec is local:remote so the user can track a differently named remote branch.
   * Failure is non-blocking: the local branch already exists.
   */
  async function pushGitBranch(repoRoot, localBranch, remoteName, remoteBranch) {
    try {
      const { stdout: remoteOut } = await executeGit(
        repoRoot,
        ['remote'],
        { maxBuffer: 1024 * 1024 },
      );
      const remotes = remoteOut.split('\n').map((line) => line.trim()).filter(Boolean);
      const remote = remoteName || remotes[0];
      if (!remote || (remoteName && !remotes.includes(remote))) {
        return { pushed: false, pushError: 'no_remote' };
      }
      const refspec = `${localBranch}:${remoteBranch || localBranch}`;
      await executeGit(
        repoRoot,
        ['push', '-u', '--', remote, refspec],
        { maxBuffer: 1024 * 1024, timeout: 60_000 },
      );
      return { pushed: true, pushError: null };
    } catch (error) {
      return { pushed: false, pushError: error?.message || String(error) };
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

  function directoryEntries(target, entries) {
    return entries.filter(entry => !isSkippedFileTreeDirName(entry.name)).map(entry => ({
      name: entry.name, isDir: entry.isDirectory(), absPath: path.join(target, entry.name),
    })).sort((left, right) => left.isDir !== right.isDir ? left.isDir ? -1 : 1
      : left.name.localeCompare(right.name, undefined, { sensitivity: 'accent' }));
  }

  function readDirectory({ absPath, workspaceRoot, relPath, documentReference } = {}) {
    if (documentReference !== undefined) {
      return Promise.resolve(options.resolveBotDocument?.({ ...documentReference, kind: 'directory' })).then(resolved => {
        if (!resolved?.ok) return { ...resolved, ok: false, status: resolved?.status ?? 'workspace_unavailable', entries: [] };
        if (typeof options.readDirectoryBounded !== 'function') return { ok: false, status: 'workspace_unavailable', entries: [] };
        const result = options.readDirectoryBounded(resolved.target, 1000);
        return { ok: true, status: 'ok', entries: directoryEntries(resolved.target, result.entries), truncated: result.truncated === true, resolvedFrom: resolved.root, resolvedPath: resolved.target };
      }).catch(error => ({ ok: false, status: ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied'
        : error?.code === 'ENOENT' ? 'not_found' : error?.code === 'ENOTDIR' ? 'not_dir' : 'error', entries: [], error: 'read_dir_failed' }));
    }
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
      const entries = directoryEntries(target, readDirectoryEntries(target));
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
      if (resolvedPath && !isSkippedFileTreePath(resolvedPath)) desired.set(resolvedPath, true);
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
        const watcher = watchDirectory(dirPath, { persistent: false, recursive: false }, () => {
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

  async function readFile({ absPath, workspaceRoot, relPath, documentReference } = {}, observationContext) {
    try {
      if (documentReference?.revision !== undefined) return await readGitDocument(documentReference);
      if (documentReference !== undefined) {
        if (!validExpectedObservation(documentReference?.expectedObservation)) return { ok: false, status: 'invalid_path', content: '' };
        const resolved = await options.resolveBotDocument?.(documentReference);
        if (!resolved?.ok) return resolved ?? { ok: false, status: 'workspace_unavailable', content: '' };
        if (documentReference.metadataOnly === true) return { ok: true, status: 'ok', content: '', metadataOnly: true,
          ...(documentReference.kind !== 'directory' ? { identity: documentIdentity(documentReference, resolved) } : {}),
          resolvedPath: resolved.target, resolvedFrom: resolved.root };
        if (documentReference.kind === 'directory') return { ok: false, status: 'not_file', content: '' };
        if (documentReference.expectedObservation && documentReference.expectedObservation.resourceId !== documentIdentity(documentReference, resolved).resourceId) {
          return { ok: false, status: 'source_changed', content: '', identity: documentIdentity(documentReference, resolved) };
        }
        const result = await readFile({ absPath: resolved.target, workspaceRoot: resolved.root }, { reference: documentReference, resolved });
        return { ...result, resolvedPath: resolved.target, resolvedFrom: resolved.root };
      }
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
      } catch (error) {
        return { ok: false, status: ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'not_found', content: '', error: 'stat_failed' };
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
      if (PACKAGED_DOCUMENT_EXTENSIONS.has(path.extname(target).toLowerCase())) {
        return { ok: false, status: 'binary', content: '', size: stat.size, resolvedFrom, error: 'packaged_document' };
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
      if (buffer.length > maxTextFileBytes) return { ok: false, status: 'too_large', content: '', size: buffer.length, resolvedFrom };
      const observed = observationContext ? observeDocumentRead(observationContext.reference, observationContext.resolved, buffer) : undefined;
      if (observed && !observed.ok) return { ...observed, content: '', size: buffer.length, resolvedFrom };
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
        ...(observed ? { identity: observed.identity, observation: observed.observation } : {}),
        size: buffer.length,
        resolvedFrom,
      };
    } catch (error) {
      return {
        ok: false,
        status: ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'error',
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

  function readImageDataUrl({ absPath, workspaceRoot, relPath, documentReference } = {}, observationContext) {
    if (documentReference?.revision !== undefined) return readGitDocument(documentReference, true);
    if (documentReference !== undefined) {
      if (!validExpectedObservation(documentReference?.expectedObservation)) return Promise.resolve({ ok: false, status: 'invalid_path', dataUrl: '' });
      return Promise.resolve(options.resolveBotDocument?.({ ...documentReference, kind: 'file' })).then(resolved => {
        if (!resolved?.ok) return { ...resolved, ok: false, status: resolved?.status ?? 'workspace_unavailable', dataUrl: '' };
        if (documentReference.expectedObservation && documentReference.expectedObservation.resourceId !== documentIdentity(documentReference, resolved).resourceId) {
          return { ok: false, status: 'source_changed', dataUrl: '', identity: documentIdentity(documentReference, resolved) };
        }
        const result = readImageDataUrl({ absPath: resolved.target, workspaceRoot: resolved.root }, { reference: documentReference, resolved });
        return { ...result, resolvedPath: resolved.target, resolvedFrom: resolved.root };
      }).catch(() => ({ ok: false, status: 'error', dataUrl: '', error: 'resolve_failed' }));
    }
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
      if (buffer.length > DEFAULT_MAX_IMAGE_FILE_BYTES) return { ok: false, status: 'too_large', dataUrl: '', size: buffer.length };
      const observed = observationContext ? observeDocumentRead(observationContext.reference, observationContext.resolved, buffer) : undefined;
      if (observed && !observed.ok) return { ...observed, dataUrl: '', size: buffer.length, resolvedFrom };
      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      if (observed) return { ok: true, status: 'ok', dataUrl, mimeType, size: buffer.length, path: target,
        resolvedFrom, identity: observed.identity, observation: observed.observation };
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

  async function searchFiles({ workspacePath, query, limit, documentReference } = {}) {
    if (documentReference === undefined) return searchWorkspaceFiles(workspacePath, { query, limit });
    try {
      const resolved = await options.resolveBotDocument?.({ ...documentReference, kind: 'directory' });
      if (!resolved?.ok) return { ok: false, status: resolved?.status ?? 'workspace_unavailable', scoped: true, files: [] };
      const result = searchWorkspaceFiles(resolved.target, { query, limit });
      return { ...result, scoped: true };
    } catch { return { ok: false, status: 'error', scoped: true, files: [] }; }
  }

  return Object.freeze({
    getGitDiff,
    getGitRangeDiff,
    listGitBranches,
    createGitBranch,
    exists,
    readDirectory,
    watchDirectories,
    readFile,
    readImageDataUrl,
    writeFile,
    mkdir,
    searchWorkspaceFiles: searchFiles,
    dispose,
  });
}
