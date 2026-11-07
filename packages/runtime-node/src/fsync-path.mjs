import { closeSync, fsyncSync, openSync } from 'node:fs';

/**
 * Windows rejects fsync on a handle without write access, while POSIX rejects
 * opening a directory for writing. Keep one durability seam for both.
 */
const readHandle = file => openSync(file, process.platform === 'win32' ? 'r+' : 'r');

function flush(fd) {
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function syncFile(file) {
  flush(readHandle(file));
}

export function syncDirectory(directory) {
  flush(readHandle(directory));
}
