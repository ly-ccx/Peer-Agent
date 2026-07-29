import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionImportPreflight,
  openFullDiskAccessSettings,
  probeDirectoryAccess,
} from './import-permission-preflight.mjs';

function makeFs({ exists = true, readdirError = null } = {}) {
  return {
    existsSync: () => exists,
    readdirSync: () => {
      if (readdirError) throw readdirError;
      return ['Default'];
    },
  };
}

test('probeDirectoryAccess reports missing path', () => {
  const res = probeDirectoryAccess('/tmp/nope', { fsImpl: makeFs({ exists: false }) });
  assert.equal(res.status, 'missing');
});

test('probeDirectoryAccess maps EPERM to blocked', () => {
  const err = Object.assign(new Error("EPERM: operation not permitted, scandir '/x'"), { code: 'EPERM' });
  const res = probeDirectoryAccess('/x', { fsImpl: makeFs({ readdirError: err }) });
  assert.equal(res.status, 'blocked');
  assert.equal(res.code, 'EPERM');
});

test('preflight marks full disk access blocked when all browser dirs deny read', () => {
  const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  const adapters = [
    {
      id: 'chrome-mac',
      browserName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      userDataRoot: '/Users/me/Library/Application Support/Google/Chrome',
      keychainBrowserId: 'Chrome',
    },
  ];
  const res = buildSessionImportPreflight({
    platform: 'darwin',
    adapters,
    fsImpl: makeFs({ readdirError: err }),
    isZh: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.ready, false);
  assert.equal(res.blocked, true);
  assert.ok(res.checks.some((c) => c.id === 'full-disk-access' && c.status === 'blocked'));
  assert.ok(res.checks.some((c) => c.action === 'open_full_disk_access'));
  assert.ok(res.guidance?.fullDiskAccess?.includes('完全磁盘访问权限'));
});

test('preflight is ready when at least one browser dir is readable', () => {
  const adapters = [
    {
      id: 'chrome-mac',
      browserName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      userDataRoot: '/Users/me/Library/Application Support/Google/Chrome',
      keychainBrowserId: 'Chrome',
    },
  ];
  const res = buildSessionImportPreflight({
    platform: 'darwin',
    adapters,
    fsImpl: makeFs({ exists: true }),
    isZh: false,
  });
  assert.equal(res.ready, true);
  assert.equal(res.blocked, false);
  assert.ok(res.checks.some((c) => c.id === 'browser:chrome-mac' && c.status === 'ok'));
});

test('non-darwin preflight is unsupported', () => {
  const res = buildSessionImportPreflight({ platform: 'linux', isZh: true });
  assert.equal(res.ready, false);
  assert.equal(res.blocked, true);
  assert.ok(res.checks.some((c) => c.id === 'platform' && c.status === 'unsupported'));
});

test('openFullDiskAccessSettings tries preference URLs', async () => {
  const opened = [];
  const res = await openFullDiskAccessSettings({
    shellOpenExternal: async (url) => {
      opened.push(url);
    },
  });
  assert.equal(res.ok, true);
  assert.ok(opened[0]?.includes('Privacy_AllFiles') || opened[0]?.includes('preference.security'));
});
