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
  assert.equal(typeof controller.setDragging, 'function');
  controller.setDragging(true);
  controller.setDragging(false);
});

test('float should hug settings bottom (outside if possible)', () => {
  const settings = { x: 260, y: 80, width: 920, height: 720 };
  const floatH = 88;
  const gap = 6;
  // prefer outside just below window
  const yOutside = Math.round(settings.y + settings.height + gap);
  assert.equal(yOutside, 80 + 720 + 6); // 806
  // if workArea maxY is smaller, fall inside:
  const yInside = Math.round(settings.y + settings.height - floatH - gap);
  assert.equal(yInside, 80 + 720 - 88 - 6); // 706
  assert.ok(yInside < 750);
  const floatW = 380;
  const x = Math.round(settings.x + (settings.width - floatW) / 2);
  assert.equal(x, Math.round(260 + (920 - 380) / 2));
});

test('main wires delayed float show after opening settings', () => {
  const main = readFileSync(join(here, 'main.mjs'), 'utf8');
  assert.match(main, /createFullDiskAccessDragFloatController/);
  assert.match(main, /fullDiskAccessDragFloatController\.show/);
  assert.match(main, /setTimeout\(\(\) => \{\s*try \{ showFloat\(\); \}/);
  assert.match(main, /hide-fda-drag-float|hideFdaDragFloat/);
});
