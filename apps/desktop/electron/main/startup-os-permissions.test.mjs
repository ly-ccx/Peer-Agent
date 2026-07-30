import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStartupOsPermissions,
  listFullDiskAccessProbePaths,
  probeProtectedDirectory,
} from './startup-os-permissions.mjs';

test('probeProtectedDirectory maps EPERM to blocked', () => {
  const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  const res = probeProtectedDirectory('/x', {
    fsImpl: { readdirSync: () => { throw err; } },
  });
  assert.equal(res.status, 'blocked');
});

test('probeProtectedDirectory maps missing to missing', () => {
  const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const res = probeProtectedDirectory('/x', {
    fsImpl: { readdirSync: () => { throw err; } },
  });
  assert.equal(res.status, 'missing');
});

test('non-darwin is not blocked for FDA startup gate', () => {
  const res = buildStartupOsPermissions({ platform: 'linux', isZh: true, includeDragTarget: false });
  assert.equal(res.blocked, false);
  assert.equal(res.openFullDiskAccessSupported, false);
});

test('FDA blocked when any protected path denies read', () => {
  const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  const home = '/Users/me';
  const paths = listFullDiskAccessProbePaths({ homeDir: home });
  const fsImpl = {
    readdirSync: (p) => {
      if (String(p).includes('Safari')) throw err;
      if (String(p).includes('Mail')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  const res = buildStartupOsPermissions({
    platform: 'darwin',
    isZh: true,
    homeDir: home,
    fsImpl,
    includeDragTarget: false,
  });
  assert.equal(res.blocked, true);
  assert.ok(res.checks.some((c) => c.id === 'full-disk-access' && c.status === 'blocked'));
  assert.ok(res.required.some((c) => c.id === 'full-disk-access'));
  // 文案不绑死 Chrome
  const detail = res.checks.find((c) => c.id === 'full-disk-access')?.detail || '';
  assert.doesNotMatch(detail, /Chrome/);
  assert.match(detail, /Agent|工作区|受保护/);
  assert.ok(paths.length >= 3);
});

test('FDA ok when a protected path is readable', () => {
  const home = '/Users/me';
  const fsImpl = {
    readdirSync: (p) => {
      if (String(p).includes('Safari')) return ['Bookmarks.plist'];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  const res = buildStartupOsPermissions({
    platform: 'darwin',
    isZh: false,
    homeDir: home,
    fsImpl,
    includeDragTarget: false,
  });
  assert.equal(res.blocked, false);
  assert.ok(res.checks.some((c) => c.id === 'full-disk-access' && c.status === 'ok'));
});
