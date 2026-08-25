import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 短 TTL：CLI/桌面高频刷新时避免主线程反复 spawnSync git。 */
const GIT_CACHE_TTL_MS = 2500;
/** @type {Map<string, { expiresAt: number, value: string }>} */
const gitCommandCache = new Map();
/** @type {Map<string, { expiresAt: number, value: object|undefined }>} */
const gitStateCache = new Map();
/** @type {Map<string, { expiresAt: number, value: object[] }>} */
const projectIndexCache = new Map();

function safeJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttlMs = GIT_CACHE_TTL_MS) {
  map.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

function defaultExecGit(workspaceRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return '';
  }
}

/** @type {(workspaceRoot: string, args: string[]) => string} */
let execGitImpl = defaultExecGit;

/** 测试注入点：替换同步 git 执行器。传 null 恢复默认。 */
export function setProjectIndexGitExecutor(executor) {
  execGitImpl = typeof executor === 'function' ? executor : defaultExecGit;
}

function runGit(workspaceRoot, args) {
  const key = `${workspaceRoot}\0${args.join('\0')}`;
  const cached = cacheGet(gitCommandCache, key);
  if (cached !== undefined) return cached;
  const value = execGitImpl(workspaceRoot, args);
  return cacheSet(gitCommandCache, key, typeof value === 'string' ? value : '');
}

function parseStatus(statusText) {
  const statusLines = String(statusText || '')
    .split('\n')
    .filter(Boolean);
  const branchLine = statusLines.find((line) => line.startsWith('## ')) ?? '';
  const fileLines = statusLines.filter((line) => !line.startsWith('## '));

  let ahead = 0;
  let behind = 0;
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  if (aheadMatch) ahead = Number(aheadMatch[1]);
  if (behindMatch) behind = Number(behindMatch[1]);

  let modifiedCount = 0;
  let untrackedCount = 0;
  let stagedCount = 0;

  for (const line of fileLines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (line.startsWith('??')) {
      untrackedCount += 1;
      continue;
    }
    if (indexStatus && indexStatus !== ' ') stagedCount += 1;
    if (worktreeStatus && worktreeStatus !== ' ') modifiedCount += 1;
  }

  return {
    ahead,
    behind,
    modifiedCount,
    untrackedCount,
    stagedCount,
    isDirty: fileLines.length > 0,
  };
}

function readRepoMeta(workspaceRoot) {
  const key = `meta:${workspaceRoot}`;
  const cached = cacheGet(gitStateCache, key);
  if (cached !== undefined) return cached;
  if (!existsSync(path.join(workspaceRoot, '.git'))) {
    return cacheSet(gitStateCache, key, null);
  }
  const branch = runGit(workspaceRoot, ['branch', '--show-current']);
  const remote = runGit(workspaceRoot, ['remote', 'get-url', 'origin']);
  return cacheSet(gitStateCache, key, {
    branch: branch || undefined,
    remote: remote || undefined,
  });
}

function readGitState(workspaceRoot, pathspec = '.') {
  const key = `state:${workspaceRoot}\0${pathspec}`;
  const cached = cacheGet(gitStateCache, key);
  if (cached !== undefined) return cached;

  const meta = readRepoMeta(workspaceRoot);
  if (!meta) return cacheSet(gitStateCache, key, undefined);

  const statusArgs = ['status', '--porcelain=v1', '--branch'];
  if (pathspec !== '.') statusArgs.push('--', pathspec);
  const status = parseStatus(runGit(workspaceRoot, statusArgs));

  return cacheSet(gitStateCache, key, {
    ...meta,
    ...status,
  });
}

function workspacePackageDirs(workspaceRoot) {
  const packageDirs = [];
  for (const group of ['apps', 'packages']) {
    const groupPath = path.join(workspaceRoot, group);
    if (!existsSync(groupPath)) continue;

    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = path.join(groupPath, entry.name);
      if (existsSync(path.join(packagePath, 'package.json'))) {
        packageDirs.push(packagePath);
      }
    }
  }

  return packageDirs.sort();
}

function toProjectId(relativePath) {
  return relativePath === '.'
    ? 'workspace-root'
    : relativePath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function createProjectEntry({ workspaceRoot, absolutePath, kind, git, gitProvided = false }) {
  const packageJson = safeJson(path.join(absolutePath, 'package.json'));
  const relativePath = path.relative(workspaceRoot, absolutePath) || '.';
  const name = packageJson?.name ?? path.basename(absolutePath);

  return {
    projectId: toProjectId(relativePath),
    name,
    absolutePath,
    relativePath,
    kind,
    packageName: packageJson?.name,
    git: gitProvided ? git : readGitState(workspaceRoot, relativePath),
    updatedAt: new Date().toISOString(),
  };
}

export function readProjectIndex({ workspaceRoot, includePackages = true, includeGit = true } = {}) {
  const cacheKey = `${String(workspaceRoot || '')}\0${includePackages ? 1 : 0}\0${includeGit ? 1 : 0}`;
  const cached = cacheGet(projectIndexCache, cacheKey);
  if (cached) return cached.map((item) => ({ ...item, git: item.git ? { ...item.git } : item.git }));

  const rootGit = includeGit ? readGitState(workspaceRoot, '.') : undefined;
  const rootProject = createProjectEntry({
    workspaceRoot,
    absolutePath: workspaceRoot,
    kind: 'workspace_root',
    git: rootGit,
    gitProvided: true,
  });

  const packageProjects = includePackages
    ? workspacePackageDirs(workspaceRoot).map((absolutePath) => {
      const relativePath = path.relative(workspaceRoot, absolutePath) || '.';
      return createProjectEntry({
        workspaceRoot,
        absolutePath,
        kind: 'workspace_package',
        git: includeGit ? readGitState(workspaceRoot, relativePath) : undefined,
        gitProvided: true,
      });
    })
    : [];

  const projects = [rootProject, ...packageProjects];
  cacheSet(projectIndexCache, cacheKey, projects);
  return projects.map((item) => ({ ...item, git: item.git ? { ...item.git } : item.git }));
}

/** 测试/调试用：清空短 TTL 缓存。 */
export function clearProjectIndexCaches() {
  gitCommandCache.clear();
  gitStateCache.clear();
  projectIndexCache.clear();
}
