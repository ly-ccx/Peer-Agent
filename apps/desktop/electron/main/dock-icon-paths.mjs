import path from 'node:path';

const PACKAGED_ICON_DIRECTORY = 'app-icons';

export function resolveDockIconPaths({ isPackaged, workspaceRoot, resourcesRoot }) {
  const iconRoot = isPackaged
    ? path.join(resourcesRoot, PACKAGED_ICON_DIRECTORY)
    : path.join(workspaceRoot, 'apps/desktop/build');

  return {
    fallback: isPackaged ? null : path.join(iconRoot, 'icon.png'),
    light: path.join(iconRoot, 'icon-macos-dock.png'),
    dark: path.join(iconRoot, 'icon-macos-dock-dark.png'),
  };
}
