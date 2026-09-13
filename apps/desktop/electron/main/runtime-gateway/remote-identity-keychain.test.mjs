import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteIdentityStore } from './remote-identity-keychain.mjs';

/** Build a fake `security` that records calls and replays canned outcomes. */
function fakeSecurity(responses) {
  const calls = [];
  const impl = async (file, args) => {
    calls.push([file, ...args]);
    const key = args[0];
    const next = responses[key];
    if (typeof next === 'function') return next(args);
    if (next instanceof Error) throw next;
    if (next === undefined) throw Object.assign(new Error('unexpected'), { code: 1 });
    return { stdout: next, stderr: '' };
  };
  return { impl, calls };
}

// Both return the *thunk* fakeSecurity replays, so the response shape is
// produced once (returning the object directly would double-wrap `stdout`).
const ok = (stdout = '') => async () => ({ stdout, stderr: '' });
const fail = (code, stderr) => async () => {
  throw Object.assign(new Error(stderr), { code, stderr });
};

test('读取已存在的条目并去掉尾部换行', async () => {
  const { impl, calls } = fakeSecurity({ 'find-generic-password': ok('c2VjcmV0\n') });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  assert.equal(await store.loadSecret(), 'c2VjcmV0');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-w', '-a',
    'device-identity', '-s', 'Peer Agent Remote Access']);
});

test('条目不存在返回 null，而不是抛错', async () => {
  const { impl } = fakeSecurity({
    'find-generic-password': fail(44, 'The specified item could not be found in the keychain.'),
  });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  assert.equal(await store.loadSecret(), null);
});

test('被拒绝访问时抛出明确错误，不静默当作不存在', async () => {
  const { impl } = fakeSecurity({
    'find-generic-password': fail(36, 'User interaction is not allowed.'),
  });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  await assert.rejects(store.loadSecret(), /keychain_permission_denied/);
});

test('写入使用 -U 更新语义，避免重复条目', async () => {
  const { impl, calls } = fakeSecurity({ 'add-generic-password': ok() });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  await store.saveSecret('c2VjcmV0');
  assert.deepEqual(calls[0], ['security', 'add-generic-password', '-U', '-a',
    'device-identity', '-s', 'Peer Agent Remote Access', '-w', 'c2VjcmV0']);
});

test('拒绝多行值与空值（实测多行会被截断）', async () => {
  const { impl, calls } = fakeSecurity({ 'add-generic-password': ok() });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  await assert.rejects(store.saveSecret('line1\nline2'), /MULTILINE_SECRET_UNSUPPORTED/);
  await assert.rejects(store.saveSecret(''), /INVALID_SECRET/);
  assert.equal(calls.length, 0, '非法输入不应触达 keychain');
});

test('删除存在的条目返回 true', async () => {
  const { impl, calls } = fakeSecurity({ 'delete-generic-password': ok('password has been deleted.') });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  assert.equal(await store.deleteSecret(), true);
  assert.equal(calls[0][1], 'delete-generic-password');
});

test('删除不存在的条目返回 false（幂等）', async () => {
  const { impl } = fakeSecurity({
    'delete-generic-password': fail(44, 'The specified item could not be found in the keychain.'),
  });
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'darwin' });
  assert.equal(await store.deleteSecret(), false);
});

test('非 macOS 平台明确不支持，不回退明文文件', async () => {
  const { impl, calls } = fakeSecurity({});
  const store = createRemoteIdentityStore({ execFileImpl: impl, platform: 'linux' });
  assert.equal(store.isSupported(), false);
  assert.equal(await store.loadSecret(), null);
  assert.equal(await store.deleteSecret(), false);
  await assert.rejects(store.saveSecret('c2VjcmV0'), /keychain_unsupported_platform/);
  assert.equal(calls.length, 0, '不支持的平台不应调用 security');
});

test('拒绝空 service/account 配置', () => {
  assert.throws(() => createRemoteIdentityStore({ service: '' }), /INVALID_SERVICE/);
  assert.throws(() => createRemoteIdentityStore({ account: '' }), /INVALID_ACCOUNT/);
});
