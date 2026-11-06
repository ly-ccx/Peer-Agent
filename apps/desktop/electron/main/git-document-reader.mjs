import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { documentIdentity, validExpectedObservation } from './document-observation.mjs';
import { isGitDocumentRevision } from './historical-document-path.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const inside = (root, target) => { const rel = path.relative(root, target); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const empty = status => ({ ok: false, status, content: '', dataUrl: '' });

/** Exact commit/tree/blob reader. No worktree fallback, checkout, filters, remote fetch or writes. */
export function createGitDocumentReader({ resolveBotDocument, executeGit, maxTextFileBytes, maxImageFileBytes,
  imageMimeFromPath, realpath = realpathSync }) {
  const environment = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete environment[key];
  const run = (cwd, args, { maxBuffer = 1024 * 1024, encoding = 'utf8' } = {}) => executeGit(cwd, ['--no-lazy-fetch', '--no-replace-objects', ...args], {
    timeout: 5000, maxBuffer, encoding,
    env: environment,
  });
  return async (reference, image = false) => {
    if (!isGitDocumentRevision(reference?.revision) || reference.kind === 'directory'
      || !validExpectedObservation(reference.expectedObservation)) return empty('invalid_ref');
    try {
      const resolved = await resolveBotDocument?.(reference);
      if (!resolved?.ok) return { ...empty(resolved?.status ?? 'workspace_unavailable') };
      let repo;
      try { repo = realpath((await run(resolved.gitDirectory ?? resolved.root, ['rev-parse', '--show-toplevel'])).stdout.trim()); }
      catch (error) { return empty(['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied'
        : ['ENOENT', 129].includes(error?.code) ? 'version_unavailable' : error?.killed || error?.code === 'ETIMEDOUT' ? 'error' : 'not_git_repo'); }
      if (!inside(repo, resolved.target) || !inside(resolved.root, resolved.target)) return empty('scope_denied');
      const scopeId = documentIdentity(reference, resolved).sourceId;
      const repositoryId = hash(JSON.stringify(['peer-git-repository-v1', scopeId, repo]));
      if (reference.revision.repositoryId && reference.revision.repositoryId !== repositoryId) return empty('source_changed');
      const commit = reference.revision.commit.toLowerCase();
      try {
        const confirmed = (await run(repo, ['rev-parse', '--verify', `${commit}^{commit}`])).stdout.trim().toLowerCase();
        if (confirmed !== commit) return empty('revision_unavailable');
      } catch (error) { return empty(error?.killed || error?.code === 'ETIMEDOUT' ? 'error' : 'revision_unavailable'); }
      const relativePath = path.relative(repo, resolved.target).split(path.sep).join('/');
      const revision = { kind: 'git', commit, repositoryId, path: relativePath };
      const identity = { sourceId: repositoryId, relativePath,
        resourceId: hash(JSON.stringify(['peer-git-document-v1', repositoryId, commit, relativePath])) };
      if (reference.expectedObservation && reference.expectedObservation.resourceId !== identity.resourceId) return empty('source_changed');
      const tree = (await run(repo, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', relativePath])).stdout;
      const entries = tree.split('\0').filter(Boolean);
      if (!entries.length) return empty('not_found');
      const separator = entries[0].indexOf('\t');
      const entry = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(entries[0].slice(0, separator));
      if (entries.length !== 1 || !entry || entries[0].slice(separator + 1) !== relativePath) return empty('invalid_path');
      if (entry[2] === 'tree') return empty('not_file');
      if (!['100644', '100755'].includes(entry[1]) || entry[2] !== 'blob') return empty('unsupported_entry');
      const sizeText = (await run(repo, ['cat-file', '-s', entry[3]])).stdout.trim();
      if (!/^\d+$/.test(sizeText)) return empty('error');
      const size = Number(sizeText);
      const limit = image || reference.metadataOnly === true && imageMimeFromPath(relativePath) ? maxImageFileBytes : maxTextFileBytes;
      if (!Number.isSafeInteger(size) || size < 0) return empty('error');
      if (size > limit) return { ...empty('too_large'), size };
      const receipt = { resolvedPath: resolved.target, resolvedFrom: resolved.root, revision, identity, size };
      if (reference.metadataOnly === true) return { ok: true, status: 'ok', content: '', dataUrl: '', metadataOnly: true, ...receipt };
      const mimeType = image ? imageMimeFromPath(relativePath) : null;
      if (image && !mimeType) return empty('unsupported_type');
      const { stdout: buffer } = await run(repo, ['cat-file', 'blob', entry[3]], { encoding: 'buffer', maxBuffer: limit + 1 });
      if (!Buffer.isBuffer(buffer) || buffer.length !== size) return empty('error');
      if (buffer.length > limit) return { ...empty('too_large'), size: buffer.length };
      const observation = { ...identity, contentVersion: hash(buffer) };
      if (reference.expectedObservation?.contentVersion && reference.expectedObservation.contentVersion !== observation.contentVersion) {
        return { ...empty('version_changed'), ...receipt, observation };
      }
      if (!image && buffer.subarray(0, 8192).includes(0)) return empty('binary');
      return image ? { ok: true, status: 'ok', dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`, mimeType, ...receipt, observation }
        : { ok: true, status: 'ok', content: buffer.toString('utf8'), ...receipt, observation };
    } catch (error) { return empty(['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'error'); }
  };
}
