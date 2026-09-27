import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectRegistry } from '@peer-agent/runtime-node';

import {
  allocateManagedName,
  cleanManagedName,
  createManagedFolder,
  discardManagedFolder,
} from './managed-folder.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-12-managed-'));
}

test('受管名字去掉分隔符，拒绝点、双点和系统保留名', () => {
  assert.equal(cleanManagedName('a/b\\c').name, 'abc');
  assert.equal(cleanManagedName('笔记\u0000').name, '笔记');
  assert.equal(cleanManagedName('.').code, 'INVALID_NAME');
  assert.equal(cleanManagedName('..').code, 'INVALID_NAME');
  assert.equal(cleanManagedName('CON').code, 'INVALID_NAME');
  assert.equal(cleanManagedName('lpt3').code, 'INVALID_NAME');
  assert.equal(cleanManagedName('   ').code, 'INVALID_NAME');
  assert.equal(Array.from(cleanManagedName('名'.repeat(50)).name).length, 40);
});

test('重名时追加 -2、-3，并注册成工作区', () => {
  const root = tempRoot();
  try {
    const managedRoot = path.join(root, 'Peer');
    const registry = createProjectRegistry({ filePath: path.join(root, 'registry.json') });
    assert.equal(cleanManagedName('笔记/../笔记').name, '笔记..笔记');
    const first = createManagedFolder({ name: '笔记', managedRoot, registry });
    const second = createManagedFolder({ name: '笔记', managedRoot, registry });
    const third = createManagedFolder({ name: '笔记', managedRoot, registry });
    assert.equal(first.ok, true);
    assert.equal(first.name, '笔记');
    assert.equal(second.name, '笔记-2');
    assert.equal(third.name, '笔记-3');
    assert.equal(existsSync(first.path), true);
    assert.equal(existsSync(second.path), true);
    assert.notEqual(first.workspace.workspaceId, second.workspace.workspaceId);
    assert.equal(registry.findByPath(first.path).workspaceId, first.workspace.workspaceId);
    const taken = allocateManagedName(managedRoot, '笔记', () => true);
    assert.equal(taken.code, 'NAME_EXHAUSTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未确认不调用废纸篓，确认后只把目录交给注入实现', () => {
  const root = tempRoot();
  try {
    const managedRoot = path.join(root, 'Peer');
    const registry = createProjectRegistry({ filePath: path.join(root, 'registry.json') });
    const created = createManagedFolder({ name: '草稿', managedRoot, registry });
    const calls = [];
    const moveToTrash = (folder) => { calls.push(folder); };
    const denied = discardManagedFolder({
      folder: created.path,
      managedRoot,
      confirmed: false,
      moveToTrash,
    });
    assert.equal(denied.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.length, 0);
    assert.equal(existsSync(created.path), true);
    const outside = discardManagedFolder({
      folder: root,
      managedRoot,
      confirmed: true,
      moveToTrash,
    });
    assert.equal(outside.code, 'OUTSIDE_MANAGED_ROOT');
    assert.equal(calls.length, 0);
    const trashed = discardManagedFolder({
      folder: created.path,
      managedRoot,
      confirmed: true,
      moveToTrash,
    });
    assert.equal(trashed.ok, true);
    assert.deepEqual(calls, [created.path]);
    assert.equal(existsSync(created.path), true);
    assert.equal(existsSync(path.join(created.path, 'README.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
