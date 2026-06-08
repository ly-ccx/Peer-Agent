import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function safeJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function runGit(workspaceRoot, args) {
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

function readGitState(workspaceRoot, pathspec = '.') {
  if (!existsSync(path.join(workspaceRoot, '.git'))) {
    return undefined;
  }

  const branch = runGit(workspaceRoot, ['branch', '--show-current']);
  const remote = runGit(workspaceRoot, ['remote', 'get-url', 'origin']);
  const statusArgs = ['status', '--porcelain=v1', '--branch'];
  if (pathspec !== '.') {
    statusArgs.push('--', pathspec);
  }

  const statusLines = runGit(workspaceRoot, statusArgs)
    .split('\n')
    .filter(Boolean);
  const branchLine = statusLines.find((line) => line.startsWith('## ')) ?? '';
  const fileLines = statusLines.filter((line) => !line.startsWith('## '));

  let ahead = 0;
  let behind = 0;
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  if (aheadMatch) {
    ahead = Number(aheadMatch[1]);
  }
  if (behindMatch) {
    behind = Number(behindMatch[1]);
  }

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
    if (indexStatus && indexStatus !== ' ') {
      stagedCount += 1;
    }
    if (worktreeStatus && worktreeStatus !== ' ') {
      modifiedCount += 1;
    }
  }

  return {
    branch: branch || undefined,
    remote: remote || undefined,
    modifiedCount,
    untrackedCount,
    stagedCount,
    ahead,
    behind,
    isDirty: fileLines.length > 0,
  };
}

function workspacePackageDirs(workspaceRoot) {
  const packageDirs = [];
  for (const group of ['apps', 'packages']) {
    const groupPath = path.join(workspaceRoot, group);
    if (!existsSync(groupPath)) {
      continue;
    }

    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packagePath = path.join(groupPath, entry.name);
      if (existsSync(path.join(packagePath, 'package.json'))) {
        packageDirs.push(packagePath);
      }
    }
  }

  return packageDirs.sort();
}

function toProjectId(relativePath) {
  return relativePath === '.' ? 'workspace-root' : relativePath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function createProjectEntry({ workspaceRoot, absolutePath, kind }) {
  const packageJson = safeJson(path.join(absolutePath, 'package.json'));
  const relativePath = path.relative(workspaceRoot, absolutePath) || '.';
  const name = packageJson?.name ?? path.basename(absolutePath);
  const git = readGitState(workspaceRoot, relativePath);

  return {
    projectId: toProjectId(relativePath),
    name,
    absolutePath,
    relativePath,
    kind,
    packageName: packageJson?.name,
    git,
    updatedAt: new Date().toISOString(),
  };
}

export function readProjectIndex({ workspaceRoot }) {
  const rootProject = createProjectEntry({
    workspaceRoot,
    absolutePath: workspaceRoot,
    kind: 'workspace_root',
  });

  const packageProjects = workspacePackageDirs(workspaceRoot).map((absolutePath) =>
    createProjectEntry({
      workspaceRoot,
      absolutePath,
      kind: 'workspace_package',
    }),
  );

  return [rootProject, ...packageProjects];
}
