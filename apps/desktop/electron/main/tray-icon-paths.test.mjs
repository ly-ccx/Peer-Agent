import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { pickExistingTrayIconPath, resolveTrayIconPaths } from './tray-icon-paths.mjs';

describe('resolveTrayIconPaths', () => {
  it('resolves development tray templates from the desktop build directory', () => {
    const paths = resolveTrayIconPaths({
      isPackaged: false,
      workspaceRoot: '/repo',
      resourcesRoot: '/repo',
    });

    assert.deepEqual(paths, {
      template: path.join('/repo', 'apps/desktop/build/trayTemplate.png'),
      template2x: path.join('/repo', 'apps/desktop/build/trayTemplate@2x.png'),
      fallback: path.join('/repo', 'apps/desktop/public/favicon.png'),
    });
  });

  it('resolves packaged tray templates from app-icons resources', () => {
    const paths = resolveTrayIconPaths({
      isPackaged: true,
      workspaceRoot: '/repo',
      resourcesRoot: '/Applications/Peer Agent.app/Contents/Resources',
    });

    assert.deepEqual(paths, {
      template: path.join('/Applications/Peer Agent.app/Contents/Resources', 'app-icons/trayTemplate.png'),
      template2x: path.join('/Applications/Peer Agent.app/Contents/Resources', 'app-icons/trayTemplate@2x.png'),
      fallback: null,
    });
  });
});

describe('pickExistingTrayIconPath', () => {
  it('prefers @2x when available, then 1x, then fallback', () => {
    const paths = {
      template: '/t.png',
      template2x: '/t2.png',
      fallback: '/f.png',
    };
    assert.equal(
      pickExistingTrayIconPath(paths, { existsSync: (p) => p === '/t.png' || p === '/t2.png' }),
      '/t2.png',
    );
    assert.equal(
      pickExistingTrayIconPath(paths, { existsSync: (p) => p === '/t.png' }),
      '/t.png',
    );
    assert.equal(
      pickExistingTrayIconPath(paths, { existsSync: (p) => p === '/t2.png' }),
      '/t2.png',
    );
    assert.equal(
      pickExistingTrayIconPath(paths, { existsSync: (p) => p === '/f.png' }),
      '/f.png',
    );
    assert.equal(
      pickExistingTrayIconPath(paths, { existsSync: () => false }),
      '/t.png',
    );
  });
});
