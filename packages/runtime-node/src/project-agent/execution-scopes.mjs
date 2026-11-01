import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Host-derived identities only. These resource scopes never grant filesystem permission. */
export function directoryResource(directory, { allowMissing = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('execution_resource_scope_unknown');
  let existing = directory, suffix = [];
  if (allowMissing) while (!existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing)); existing = path.dirname(existing);
  }
  const canonical = realpathSync(existing), stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error('execution_resource_scope_unknown');
  return { resourceRef: `directory:${path.join(canonical, ...suffix)}`, identity: suffix.length ? 'missing' : `${stat.dev}:${stat.ino}` };
}
function smallText(file) {
  if (!statSync(file).isFile() || statSync(file).size > 16_384) throw new Error('execution_resource_scope_unknown');
  return readFileSync(file, 'utf8').trim();
}
/** Shell can mutate shared Git refs even from a distinct worktree. Discover through native Git metadata. */
export function providerExecutionScopes(directory) {
  let current = realpathSync(directory);
  const scopes = [{ kind: 'directory', path: current }];
  while (true) {
    const marker = path.join(current, '.git');
    if (existsSync(marker)) {
      const gitdir = statSync(marker).isDirectory() ? marker : (() => {
        const match = /^gitdir:\s*(.+)$/.exec(smallText(marker));
        if (!match) throw new Error('execution_resource_scope_unknown');
        return path.resolve(current, match[1]);
      })();
      const common = path.join(gitdir, 'commondir');
      const git = realpathSync(existsSync(common) ? path.resolve(gitdir, smallText(common)) : gitdir);
      if (!statSync(git).isDirectory()) throw new Error('execution_resource_scope_unknown');
      scopes.push({ kind: 'directory', path: git }); return scopes;
    }
    if (path.dirname(current) === current) return scopes;
    current = path.dirname(current);
  }
}
export function providerFileScopes(file) {
  let directory = path.dirname(existsSync(file) ? realpathSync(file) : path.resolve(file));
  while (!existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  return [{ kind: 'directory', path: realpathSync(directory) }];
}
