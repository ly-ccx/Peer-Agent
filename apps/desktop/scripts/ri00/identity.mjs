import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function resolveDestination(value) {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(resolveDestination(path.dirname(absolute)), path.basename(absolute));
}

/** Content identity without publishing private file names or contents. Symlinks are refused. */
export function contentIdentity(root) {
  const digest = createHash('sha256');
  let files = 0, bytes = 0;
  function visit(file, relative) {
    const before = fs.lstatSync(file, { bigint: true });
    if (before.isSymbolicLink()) throw new Error('identity_symlink_forbidden');
    if (before.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else if (before.isFile()) {
      const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      digest.update(JSON.stringify([relative.split(path.sep).join('/'), String(before.size), hash]) + '\n');
      files++; bytes += Number(before.size);
    } else throw new Error('identity_special_file_forbidden');
    const after = fs.lstatSync(file, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('identity_input_changed_while_reading');
  }
  visit(root, '');
  return { algorithm: 'sha256-sorted-relative-name-size-content-v1', files, bytes, sha256: digest.digest('hex') };
}

export function productionIdentity(moduleRoot) {
  return [
    'packages/runtime-node/dist', 'packages/conversation-store/dist',
    'apps/desktop/electron/main/project-agent', 'apps/desktop/electron/main/ipc',
  ].map(relative => ({ relative, ...contentIdentity(path.join(moduleRoot, relative)) }));
}

/** The three copied read stores are inputs; diagnostic logs and SQLite lock files are outputs. */
export function fixtureIdentity(root) {
  return ['goal-plans', 'conversations', 'projects'].map(relative => ({ relative, ...contentIdentity(path.join(root, relative)) }));
}
