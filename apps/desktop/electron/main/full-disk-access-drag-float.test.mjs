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
  const lifecycle = [];
  const registrations = [];
  /** @type {any} */
  let created = null;
  let closedHandler = null;
  const BrowserWindow = function BrowserWindow(opts) {
    created = {
      opts,
      _visible: false,
      isDestroyed: () => false,
      isVisible: () => created._visible,
      showInactive() { created._visible = true; },
      hide() { created._visible = false; },
      close() {
        created._visible = false;
        lifecycle.push('close');
        closedHandler?.();
      },
      setAlwaysOnTop() {},
      setVisibleOnAllWorkspaces() {},
      moveTop() {},
      setBounds(b) { bounds.push({ ...b }); },
      loadURL(url) {
        loads.push(url);
        lifecycle.push(`load:${url}`);
        return Promise.resolve();
      },
      on(name, handler) {
        if (name === 'closed') closedHandler = handler;
      },
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
    registerTrustedWindow: ({ window, url }) => {
      assert.equal(window, created);
      registrations.push(url);
      lifecycle.push(`register:${url}`);
      let disposed = false;
      return () => {
        if (disposed) return false;
        disposed = true;
        lifecycle.push(`dispose:${url}`);
        return true;
      };
    },
    isZh: () => true,
  });
  const res = controller.show({ isZh: true, ttlMs: 0 });
  assert.equal(res.ok, true);
  assert.equal(created.opts.alwaysOnTop, true);
  assert.equal(registrations[0], loads[0]);
  assert.deepEqual(lifecycle.slice(0, 2), [`register:${loads[0]}`, `load:${loads[0]}`]);
  const html = decodeURIComponent(loads[0].slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /startAppDrag/);
  assert.match(html, /hideFdaDragFloat/);
  assert.match(html, /preventDefault/);
  controller.show({ isZh: false, ttlMs: 0 });
  assert.notEqual(loads[1], loads[0]);
  assert.equal(registrations[1], loads[1]);
  assert.deepEqual(lifecycle.slice(2, 5), [
    `dispose:${loads[0]}`,
    `register:${loads[1]}`,
    `load:${loads[1]}`,
  ]);
  assert.equal(controller.isOpen(), true);
  controller.hide();
  assert.equal(controller.isOpen(), false);
  assert.equal(typeof controller.setDragging, 'function');
  controller.setDragging(true);
  controller.setDragging(false);
  assert.ok(bounds.length >= 1);
  controller.destroy();
  assert.deepEqual(lifecycle.slice(-2), [`dispose:${loads[1]}`, 'close']);
  controller.destroy();
  assert.equal(lifecycle.filter((entry) => entry === `dispose:${loads[1]}`).length, 1);
});

test('float should glue to settings bottom inside with 4px padding', () => {
  const settings = { x: 260, y: 80, width: 920, height: 720 };
  const floatH = 88;
  const y = Math.round(settings.y + settings.height - floatH - 4);
  assert.equal(y, 80 + 720 - 88 - 4); // 708
  // top of float should be near bottom of settings, not screen bottom
  assert.ok(y > settings.y + settings.height * 0.5);
  assert.equal(y + floatH + 4, settings.y + settings.height);
  const floatW = 380;
  const x = Math.round(settings.x + (settings.width - floatW) / 2);
  assert.equal(x, Math.round(260 + (920 - 380) / 2));
});

test('main wires delayed float show after opening settings', () => {
  const main = readFileSync(join(here, 'main.mjs'), 'utf8');
  assert.match(main, /createFullDiskAccessDragFloatController/);
  assert.match(main, /fullDiskAccessDragFloatController\.show/);
  assert.match(main, /showFloat\(/);
  assert.match(main, /for \(const ms of \[250, 500, 900, 1500, 2400\]\)/);
  assert.match(main, /hide-fda-drag-float|hideFdaDragFloat/);
});
