import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, 'main.mjs'), 'utf8');
const owner = readFileSync(join(here, 'ipc/register-browser-ipc.mjs'), 'utf8');
const service = readFileSync(join(here, 'browser-fda-drag-application-service.mjs'), 'utf8');
const preload = readFileSync(join(here, '../preload/preload.cjs'), 'utf8');

test('start-app-drag remains a synchronous sendSync → owner → service chain', () => {
  assert.match(preload, /sendSync\(['"]browser:start-app-drag['"]/);
  assert.doesNotMatch(main, /ipcMain\.on\(['"]browser:start-app-drag['"]/);

  const ownerIndex = owner.indexOf("ipc.on('browser:start-app-drag'");
  assert.notEqual(ownerIndex, -1);
  const ownerSlice = owner.slice(ownerIndex, ownerIndex + 320);
  assert.doesNotMatch(ownerSlice, /async\s*\(/);
  assert.match(ownerSlice, /event\.returnValue\s*=\s*ports\.startAppDrag\(payload, event\.sender\)/);

  const serviceIndex = service.indexOf('function startAppDrag(');
  assert.notEqual(serviceIndex, -1);
  const serviceSlice = service.slice(
    serviceIndex,
    service.indexOf('async function getAppDragTarget', serviceIndex),
  );
  assert.doesNotMatch(serviceSlice, /\bawait\b/);
  assert.doesNotMatch(serviceSlice, /getFileIcon/);
  assert.match(serviceSlice, /ports\.getCachedDragIcon\(filePath\)/);
  assert.match(serviceSlice, /ports\.startDrag\(\{ sender, filePath, dragIcon \}\)/);
});

test('hide-fda-drag-float-sync assigns returnValue in the owner stack', () => {
  const ownerIndex = owner.indexOf("ipc.on('browser:hide-fda-drag-float-sync'");
  assert.notEqual(ownerIndex, -1);
  const ownerSlice = owner.slice(ownerIndex, ownerIndex + 240);
  assert.doesNotMatch(ownerSlice, /async\s*\(/);
  assert.match(ownerSlice, /event\.returnValue\s*=\s*ports\.hideDragFloatSync\(\)/);

  const serviceIndex = service.indexOf('function hideDragFloatSync(');
  assert.notEqual(serviceIndex, -1);
  const serviceSlice = service.slice(
    serviceIndex,
    service.indexOf('function setDragFloatDragging', serviceIndex),
  );
  assert.doesNotMatch(serviceSlice, /\bawait\b/);
});
