import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  getDesktopPreviewService,
  registerDesktopPreviewService,
  unregisterDesktopPreviewService,
} from './desktop-preview-service.mjs';

const tempRoots = [];

function makeTree() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-lookup-')));
  tempRoots.push(root);
  const nested = path.join(root, 'apps', 'desktop');
  mkdirSync(nested, { recursive: true });
  const sibling = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-preview-other-')));
  tempRoots.push(sibling);
  const spoof = `${root}-other`;
  mkdirSync(spoof, { recursive: true });
  tempRoots.push(spoof);
  return { root, nested, sibling, spoof };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

test('preview lookup resolves the registered root and nested session workspaces', () => {
  const { root, nested } = makeTree();
  const store = {};
  const provider = { providerId: 'local.desktop.preview' };
  registerDesktopPreviewService(store, root, provider);
  try {
    assert.equal(getDesktopPreviewService(store, root), provider);
    assert.equal(getDesktopPreviewService(store, nested), provider);
    assert.equal(getDesktopPreviewService(store, path.join(nested, '.')), provider);
  } finally {
    unregisterDesktopPreviewService(store);
  }
});

test('preview lookup rejects a different repository and a prefix-spoofed sibling', () => {
  const { root, sibling, spoof } = makeTree();
  const store = {};
  const provider = { providerId: 'local.desktop.preview' };
  registerDesktopPreviewService(store, root, provider);
  try {
    assert.equal(getDesktopPreviewService(store, sibling), null);
    assert.equal(getDesktopPreviewService(store, spoof), null);
    assert.equal(getDesktopPreviewService({}, root), null);
    assert.equal(getDesktopPreviewService(store, path.join(os.tmpdir(), 'peer-preview-missing')), null);
  } finally {
    unregisterDesktopPreviewService(store);
  }
});
