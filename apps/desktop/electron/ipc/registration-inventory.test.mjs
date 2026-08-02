import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC_CATALOG } from './channels.mjs';
import {
  scanRegistrationSource,
  validateRegistrationInventory,
} from './registration-inventory.mjs';

function entry(key, transport = 'invoke', owner = `${key.split(':', 1)[0]}-ipc`) {
  return { key, channel: key, transport, owner };
}

function listProductionModules(root) {
  const files = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, item.name);
    if (item.isDirectory()) {
      files.push(...listProductionModules(absolutePath));
    } else if (item.isFile() && item.name.endsWith('.mjs') && !item.name.endsWith('.test.mjs')) {
      files.push({
        path: path.relative(root, absolutePath),
        source: readFileSync(absolutePath, 'utf8'),
      });
    }
  }
  return files;
}

test('scanner recognizes multiline direct and owner-scoped registrations', () => {
  const source = `
    ipcMain.handle(\n      'alpha:get',\n      () => null,\n    );
    owner('beta-ipc', (ipc) => {
      ipc.on('beta:sync', () => null);
    });
  `;

  assert.deepEqual(
    scanRegistrationSource(source).map(({ operation, key, owner, kind }) => ({
      operation,
      key,
      owner,
      kind,
    })),
    [
      { operation: 'handle', key: 'alpha:get', owner: null, kind: 'direct' },
      { operation: 'on', key: 'beta:sync', owner: 'beta-ipc', kind: 'owner' },
    ],
  );
});

test('inventory rejects owner, transport, duplicate, and coverage violations', () => {
  assert.throws(
    () => validateRegistrationInventory({
      catalog: { 'alpha:get': entry('alpha:get') },
      files: [{ path: 'owner.mjs', source: `owner('wrong-ipc', (ipc) => { ipc.handle('alpha:get', () => null); });` }],
    }),
    /owner mismatch/,
  );

  assert.throws(
    () => validateRegistrationInventory({
      catalog: { 'alpha:get': entry('alpha:get') },
      files: [{ path: 'sync.mjs', source: `ipcMain.on('alpha:get', () => null);` }],
    }),
    /transport mismatch/,
  );

  assert.throws(
    () => validateRegistrationInventory({
      catalog: { 'alpha:get': entry('alpha:get') },
      files: [
        { path: 'direct.mjs', source: `ipcMain.handle('alpha:get', () => null);` },
        { path: 'owner.mjs', source: `owner('alpha-ipc', (ipc) => { ipc.handle('alpha:get', () => null); });` },
      ],
    }),
    /Duplicate Main registration/,
  );

  assert.throws(
    () => validateRegistrationInventory({
      catalog: {
        'alpha:get': entry('alpha:get'),
        'beta:get': entry('beta:get'),
      },
      files: [{ path: 'direct.mjs', source: `ipcMain.handle('alpha:get', () => null);` }],
    }),
    /beta:get/,
  );
});

test('current production inventory has one registration for every renderer-to-main channel', () => {
  const mainRoot = path.resolve(import.meta.dirname, '../main');
  const inventory = validateRegistrationInventory({
    catalog: DESKTOP_IPC_CATALOG,
    files: listProductionModules(mainRoot),
  });

  assert.equal(inventory.registrationCount, 173);
  assert.equal(inventory.handleCount, 169);
  assert.equal(inventory.onCount, 4);
  assert.equal(inventory.directCount, 0);
  assert.equal(inventory.ownerCount, 173);
});
