import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

/**
 * 打开本地路径。三种打开方式：
 * - mode='auto'（默认）：交给系统默认程序（shell.openPath），失败兜底到 Finder。
 * - mode='editor'：交给指定编辑器（需注入 launchEditor）。
 * - mode='reveal'：直接在 Finder / 资源管理器中定位。
 *
 * 打开目标由 target 决定：
 * - target='self'（默认）：absPath 本身，可以是文件也可以是目录。
 * - target='parent'：absPath 所在目录（文件的父目录；若 absPath 本身是目录则取其自身）。
 *
 * 与旧行为的关系：目录不再依赖「openPath 失败后兜底 Finder」这种偶然行为，而是显式判定。
 */
export function createOpenPathApplicationService({
  openPath,
  showItemInFolder,
  launchEditor,
} = {}) {
  const open = assertFunction(openPath, 'openPath');
  const show = assertFunction(showItemInFolder, 'showItemInFolder');
  const launch = typeof launchEditor === 'function' ? launchEditor : null;

  return Object.freeze({
    async open({ absPath, workspaceRoot, target = 'self', mode = 'auto', editorId } = {}) {
      try {
        if (!absPath || typeof absPath !== 'string') {
          return { ok: false, reason: 'invalid_path' };
        }
        const normalized = path.normalize(absPath);
        if (!path.isAbsolute(normalized)) {
          return { ok: false, reason: 'not_absolute' };
        }
        if (workspaceRoot && typeof workspaceRoot === 'string') {
          const root = path.resolve(workspaceRoot);
          const relative = path.relative(root, normalized);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { ok: false, reason: 'out_of_workspace' };
          }
        }
        if (!existsSync(normalized)) {
          return { ok: false, reason: 'not_found' };
        }

        let isDirectory = false;
        try {
          isDirectory = statSync(normalized).isDirectory();
        } catch {
          isDirectory = false;
        }

        // 解析真正要打开的路径：'parent' 时取所在目录（目录自身即其所在目录）。
        let resolved = normalized;
        if (target === 'parent') {
          resolved = isDirectory ? normalized : path.dirname(normalized);
          isDirectory = true;
        } else if (target !== 'self') {
          return { ok: false, reason: 'invalid_target' };
        }

        const kind = isDirectory ? 'directory' : 'file';

        if (mode === 'reveal') {
          show(resolved);
          return { ok: true, kind, mode: 'reveal', path: resolved };
        }

        if (mode === 'editor') {
          if (!launch) return { ok: false, reason: 'editor_unavailable' };
          const result = await launch({ editorId, absPath: resolved });
          if (!result?.ok) {
            return {
              ok: false,
              reason: result?.reason || 'launch_failed',
              message: result?.message || '',
            };
          }
          return { ok: true, kind, mode: 'editor', editorId: result.editorId, path: resolved };
        }

        if (mode !== 'auto') {
          return { ok: false, reason: 'invalid_mode' };
        }

        const error = await open(resolved);
        if (error) {
          show(resolved);
          return { ok: true, fallback: 'show-in-folder' };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'error', message: error?.message || String(error) };
      }
    },
  });
}
