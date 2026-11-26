import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Same workspace layout, media types and cutoff as peer-project-agent/attachments.rs.
const EXTENSIONS = new Map(Object.entries({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg',
}));
const INLINE_BYTES = 32 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');

function blobDirectory(root, workspaceId) {
  const workspace = path.join(root, workspaceId);
  if (!lstatSync(workspace).isDirectory()) throw Error('Invalid image workspace');
  return path.join(workspace, 'attachment-blobs');
}

/** Legacy queue/model consumers still need inline data. Add the durable ref without changing that contract. */
export function persistInputImageBlob(root, workspaceId, attachment) {
  const ext = EXTENSIONS.get(attachment.mimeType);
  if (!ext || attachment.sourceKind !== 'user_upload' || attachment.kind !== 'image'
    || !attachment.dataUrl || attachment.dataUrl.length <= INLINE_BYTES * 4 / 3) return attachment;
  const bytes = Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), 'base64');
  if (bytes.length <= INLINE_BYTES) return attachment;
  const blobDigest = digestOf(bytes);
  const directory = blobDirectory(root, workspaceId);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(directory).isDirectory()) throw Error('Invalid image blob directory');
  const file = path.join(directory, `${blobDigest}.${ext}`);
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  }
  return { ...attachment, blobDigest };
}

/** Only workspace-owned content addresses are accepted; never resolve a renderer path. */
export function readInputImageBlob(root, workspaceId, blobDigest, mimeType) {
  const ext = EXTENSIONS.get(mimeType);
  if (!ext || typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId)
    || typeof blobDigest !== 'string' || !/^[a-f0-9]{64}$/.test(blobDigest)) return null;
  let fd;
  try {
    const directory = blobDirectory(root, workspaceId);
    if (!lstatSync(directory).isDirectory()) return null;
    const file = path.join(directory, `${blobDigest}.${ext}`);
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return null;
      offset += count;
    }
    if (digestOf(bytes) !== blobDigest) return null;
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
