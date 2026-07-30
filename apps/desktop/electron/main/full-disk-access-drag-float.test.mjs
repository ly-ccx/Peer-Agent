import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createFullDiskAccessDragFloatController } from './full-disk-access-drag-float.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('drag float controller builds always-on-top window and html drag payload', () => {
  const loads = [];
  const bounds = [];
  /** @type {any} */
  let created = null;
  const BrowserWindow = function BrowserWindow(opts) {
    created = {
      opts,
      _visible: false,
      isDestroyed: () => false,
      isVisible: () => created._visible,
      showInactive() { created._visible = true; },
      hide() { created._visible = false; },
      close() { created._visible = false; },
      setAlwaysOnTop() {},
      setVisibleOnAllWorkspaces() {},
      moveTop() {},
      setBounds(b) { bounds.push(b); },
      loadURL(url) { loads.push(url); return Promise.resolve(); },
      on() {},
    };
    return created;
  };
  const controller = createFullDiskAccessDragFloatController({
    BrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    path,
    existsSync: () => true,
    preloadPath: '/tmp/preload.cjs',
    resolveDragTarget: () => ({ ok: true, appPath: '/Applications/Peer Agent.app', displayName: 'Peer Agent' }),
    resolveLogoFilePath: () => '/tmp/logo.png',
    resolveLogoDataUrl: () => 'data:image/png;base64,aaa',
    isZh: () => true,
  });
  const res = controller.show({ isZh: true, ttlMs: 0 });
  assert.equal(res.ok, true);
  assert.equal(created.opts.alwaysOnTop, true);
  assert.equal(created.opts.frame, false);
  assert.ok(loads[0].startsWith('data:text/html'));
  const html = decodeURIComponent(loads[0].slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /startAppDrag/);
  assert.match(html, /Peer Agent/);
  assert.match(html, /完全磁盘访问|Full Disk Access/);
  assert.equal(bounds.length >= 1, true);
  assert.equal(controller.isOpen(), true);
  controller.hide();
  assert.equal(controller.isOpen(), false);
});

test('main wires open-full-disk-access-settings to show drag float', () => {
  const main = readFileSync(join(here, 'main.mjs'), 'utf8');
  assert.match(main, /createFullDiskAccessDragFloatController/);
  assert.match(main, /fullDiskAccessDragFloatController\.show/);
  assert.match(main, /hide-fda-drag-float|hideFdaDragFloat/);
});
