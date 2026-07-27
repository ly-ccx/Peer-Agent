import path from 'node:path';

const PACKAGED_ICON_DIRECTORY = 'app-icons';

/**
 * Resolve tray Template image paths (macOS menu bar).
 * Prefer trayTemplate.png / @2x; fall back to favicon only in development.
 */
export function resolveTrayIconPaths({ isPackaged, workspaceRoot, resourcesRoot }) {
  const iconRoot = isPackaged
    ? path.join(resourcesRoot, PACKAGED_ICON_DIRECTORY)
    : path.join(workspaceRoot, 'apps/desktop/build');

  const publicRoot = isPackaged
    ? null
    : path.join(workspaceRoot, 'apps/desktop/public');

  return {
    template: path.join(iconRoot, 'trayTemplate.png'),
    template2x: path.join(iconRoot, 'trayTemplate@2x.png'),
    /** Dev-only soft fallback when Template assets are missing. */
    fallback: publicRoot ? path.join(publicRoot, 'favicon.png') : null,
  };
}

/**
 * Prefer @2x Template on HiDPI (sharper edges). Fall back to 1x, then favicon.
 * @param {{ prefer2x?: boolean }} [options]
 */
export function pickExistingTrayIconPath(paths, { existsSync, prefer2x = true } = {}) {
  const exists = typeof existsSync === 'function' ? existsSync : null;
  if (!exists) {
    return prefer2x ? (paths.template2x || paths.template) : paths.template;
  }
  if (prefer2x && exists(paths.template2x)) return paths.template2x;
  if (exists(paths.template)) return paths.template;
  if (exists(paths.template2x)) return paths.template2x;
  if (paths.fallback && exists(paths.fallback)) return paths.fallback;
  return paths.template;
}
