import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, 'main.mjs'), 'utf8');
const preload = readFileSync(join(here, '../preload/preload.cjs'), 'utf8');

test('start-app-drag is synchronous sendSync + startDrag (no await before startDrag)', () => {
  assert.match(preload, /startAppDrag:[\s\S]*sendSync\('browser:start-app-drag'/);
  assert.doesNotMatch(preload, /startAppDrag:[\s\S]*send\('browser:start-app-drag'/);
  // handler must not be async
  assert.match(main, /ipcMain\.on\('browser:start-app-drag', \(event, payload/);
  assert.doesNotMatch(main, /ipcMain\.on\('browser:start-app-drag', async/);
  // startDrag present; await getFileIcon should not appear inside the handler window
  const idx = main.indexOf("ipcMain.on('browser:start-app-drag'");
  const slice = main.slice(idx, idx + 4000);
  assert.match(slice, /startDrag\(/);
  assert.doesNotMatch(slice, /await app\.getFileIcon/);
});
