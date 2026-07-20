import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveDockIconPaths } from './dock-icon-paths.mjs';

describe('resolveDockIconPaths', () => {
  it('resolves development icons from the desktop build directory', () => {
    const paths = resolveDockIconPaths({
      isPackaged: false,
      workspaceRoot: '/repo',
      resourcesRoot: '/repo',
    });

    assert.deepEqual(paths, {
      fallback: path.join('/repo', 'apps/desktop/build/icon.png'),
      light: path.join('/repo', 'apps/desktop/build/icon-macos-dock.png'),
      dark: path.join('/repo', 'apps/desktop/build/icon-macos-dock-dark.png'),
    });
  });

  it('resolves packaged icons from Electron resources', () => {
    const paths = resolveDockIconPaths({
      isPackaged: true,
      workspaceRoot: null,
      resourcesRoot: '/Applications/Peer Agent.app/Contents/Resources',
    });

    assert.deepEqual(paths, {
      fallback: null,
      light: path.join('/Applications/Peer Agent.app/Contents/Resources', 'app-icons/icon-macos-dock.png'),
      dark: path.join('/Applications/Peer Agent.app/Contents/Resources', 'app-icons/icon-macos-dock-dark.png'),
    });
  });
});
