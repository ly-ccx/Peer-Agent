import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function createOpenPathApplicationService({ openPath, showItemInFolder } = {}) {
  const open = assertFunction(openPath, 'openPath');
  const show = assertFunction(showItemInFolder, 'showItemInFolder');

  return Object.freeze({
    async open({ absPath, workspaceRoot } = {}) {
      try {
        if (!absPath || typeof absPath !== 'string') {
          return { ok: false, reason: 'invalid_path' };
        }
        const target = path.normalize(absPath);
        if (!path.isAbsolute(target)) {
          return { ok: false, reason: 'not_absolute' };
        }
        if (workspaceRoot && typeof workspaceRoot === 'string') {
          const root = path.resolve(workspaceRoot);
          const relative = path.relative(root, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { ok: false, reason: 'out_of_workspace' };
          }
        }
        if (!existsSync(target)) {
          return { ok: false, reason: 'not_found' };
        }
        let isDirectory = false;
        try {
          isDirectory = statSync(target).isDirectory();
        } catch {
          isDirectory = false;
        }
        const error = await open(target);
        if (error) {
          show(target);
          return { ok: true, fallback: 'show-in-folder' };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'error', message: error?.message || String(error) };
      }
    },
  });
}
