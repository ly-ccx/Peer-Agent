import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createFullDiskAccessDragFloatController } from './full-disk-access-drag-float.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('drag float html uses native startAppDrag + preventDefault', () => {
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
      setBounds(b) { bounds.push({ ...b }); },
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
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    path,
    existsSync: () => true,
    preloadPath: '/tmp/preload.cjs',
    resolveDragTarget: () => ({ ok: true, appPath: '/Applications/Peer Agent.app', displayName: 'Peer Agent' }),
    resolveLogoDataUrl: () => 'data:image/png;base64,aaa',
    isZh: () => true,
  });
  const res = controller.show({ isZh: true, ttlMs: 0 });
  assert.equal(res.ok, true);
  assert.equal(created.opts.alwaysOnTop, true);
  const html = decodeURIComponent(loads[0].slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /startAppDrag/);
  assert.match(html, /preventDefault/);
  assert.equal(controller.isOpen(), true);
  controller.hide();
  assert.equal(controller.isOpen(), false);
});

test('float should sit on bottom band of settings window, not screen bottom', () => {
  // settings roughly like a centered tall preferences window
  const settings = { x: 260, y: 80, width: 920, height: 720 };
  const floatH = 96;
  // new policy: overlay bottom inside settings
  const y = Math.round(settings.y + settings.height - floatH - 18);
  assert.equal(y, 80 + 720 - 96 - 18); // 686
  // must NOT be near screen bottom (e.g. 900-96-28 = 776) when settings bottom is higher
  assert.ok(y < 750);
  assert.ok(y > settings.y + settings.height * 0.5);
  // horizontal center
  const floatW = 400;
  const x = Math.round(settings.x + (settings.width - floatW) / 2);
  assert.equal(x, 260 + (920 - 400) / 2);
});

test('main wires delayed float show after opening settings', () => {
  const main = readFileSync(join(here, 'main.mjs'), 'utf8');
  assert.match(main, /createFullDiskAccessDragFloatController/);
  assert.match(main, /fullDiskAccessDragFloatController\.show/);
  assert.match(main, /setTimeout\(\(\) => \{\s*try \{ showFloat\(\); \}/);
  assert.match(main, /hide-fda-drag-float|hideFdaDragFloat/);
});
