import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)$/;

function runGit(args, { cwd = repositoryRoot, runner = spawnSync } = {}) {
  const result = runner('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error,
  };
}

function requireGitSuccess(args, options) {
  const result = runGit(args, options);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `git exited with ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(String(tag ?? '').trim());
  if (!match) {
    throw new Error(
      `Unsupported release tag ${JSON.stringify(tag)}; expected vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N`,
    );
  }
  const version = match[1];
  return {
    tag: `v${version}`,
    version,
    prerelease: version.includes('-'),
  };
}

export function checkReleaseSource({
  tag,
  expectedVersion,
  commit = 'HEAD',
  mainRef = 'origin/main',
  cwd = repositoryRoot,
  runner = spawnSync,
}) {
  const release = parseReleaseTag(tag);
  const normalizedExpectedVersion = String(expectedVersion ?? '').trim();
  if (release.version !== normalizedExpectedVersion) {
    throw new Error(
      `Release tag ${release.tag} resolves to version ${release.version}, but VERSION is ${normalizedExpectedVersion || '<empty>'}`,
    );
  }

  const commitSha = requireGitSuccess(['rev-parse', `${commit}^{commit}`], { cwd, runner });
  if (release.prerelease) {
    return { ...release, commitSha, mainRef, mainContained: null };
  }

  requireGitSuccess(['rev-parse', '--verify', `${mainRef}^{commit}`], { cwd, runner });
  const ancestry = runGit(['merge-base', '--is-ancestor', commitSha, mainRef], { cwd, runner });
  if (ancestry.error || ancestry.status > 1) {
    const detail = ancestry.error?.message || ancestry.stderr || `git exited with ${ancestry.status}`;
    throw new Error(`Could not compare ${commitSha} with ${mainRef}: ${detail}`);
  }
  if (ancestry.status !== 0) {
    throw new Error(
      `Stable release ${release.tag} is blocked: commit ${commitSha} is not contained in ${mainRef}. Merge the release commit into main before creating the stable tag.`,
    );
  }

  return { ...release, commitSha, mainRef, mainContained: true };
}

export function runReleaseSourceCheck({
  tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME,
  expectedVersion = readFileSync(join(repositoryRoot, 'VERSION'), 'utf8').trim(),
  commit = process.env.RELEASE_COMMIT || 'HEAD',
  mainRef = process.env.RELEASE_MAIN_REF || 'origin/main',
  cwd = repositoryRoot,
  runner = spawnSync,
} = {}) {
  const result = checkReleaseSource({ tag, expectedVersion, commit, mainRef, cwd, runner });
  const source = result.prerelease
    ? 'prerelease branch allowed'
    : `stable commit contained in ${result.mainRef}`;
  console.log(`Release source check passed: ${result.tag} -> ${result.commitSha} (${source})`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runReleaseSourceCheck();
  } catch (error) {
    console.error(`Release source check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
