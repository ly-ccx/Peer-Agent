import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteAccessController, normalizeRemoteSettings } from './remote-access-controller.mjs';

/** In-memory settings store shaped like the real one (flat namespace, merge). */
function memorySettings(initial = {}) {
  let data = { ...initial };
  return {
    getAll: () => ({ ...data }),
    merge: (partial) => { data = { ...data, ...partial }; return { ...data }; },
    raw: () => ({ ...data }),
  };
}

/** Session factory that records lifecycle calls and reports reversible status. */
function sessionFactory(log) {
  return ({ gatewayOrigin, workspaceId, deviceName }) => {
    const record = { gatewayOrigin, workspaceId, deviceName, stopped: false, started: 0 };
    log.push(record);
    return {
      record,
      async start() { record.started += 1; },
      stop() { record.stopped = true; },
      status: () => ({
        online: !record.stopped && record.started > 0,
        deviceId: record.stopped ? null : 'device-1',
        connectionEpoch: record.stopped ? 0 : 5,
      }),
    };
  };
}

const valid = { enabled: true, gatewayOrigin: 'https://peer.example', workspaceId: 'ws-1' };

test('规范化：默认值全关且为空', () => {
  assert.deepEqual(normalizeRemoteSettings(undefined), {
    enabled: false, gatewayOrigin: '', workspaceId: '',
  });
});

test('规范化：拒绝非 https、带路径、非法工作区', () => {
  assert.throws(() => normalizeRemoteSettings({ gatewayOrigin: 'http://peer.example' }), /INVALID_GATEWAY_ORIGIN/);
  assert.throws(() => normalizeRemoteSettings({ gatewayOrigin: 'https://peer.example/path' }), /INVALID_GATEWAY_ORIGIN/);
  assert.throws(() => normalizeRemoteSettings({ workspaceId: 'bad id!' }), /INVALID_WORKSPACE_ID/);
  assert.throws(() => normalizeRemoteSettings({ enabled: 'yes' }), /INVALID_ENABLED/);
});

test('规范化：开启但缺地址或工作区时拒绝', () => {
  assert.throws(() => normalizeRemoteSettings({ enabled: true }), /INCOMPLETE_REMOTE_SETTINGS/);
  assert.throws(() => normalizeRemoteSettings({ enabled: true, gatewayOrigin: 'https://peer.example' }),
    /INCOMPLETE_REMOTE_SETTINGS/);
});

test('规范化：去掉尾部斜杠，保留端口', () => {
  const out = normalizeRemoteSettings({ gatewayOrigin: 'https://peer.example:8443/' });
  assert.equal(out.gatewayOrigin, 'https://peer.example:8443');
});

test('默认关闭时不建立连接', async () => {
  const log = [];
  const controller = createRemoteAccessController({
    settingsStore: memorySettings(), deviceName: 'mac', createSession: sessionFactory(log),
  });
  const status = await controller.apply();
  assert.equal(status.active, false);
  assert.equal(log.length, 0);
});

test('开启后建立连接并暴露状态（不含密钥）', async () => {
  const log = [];
  const store = memorySettings();
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory(log),
  });
  const status = await controller.update(valid);
  assert.equal(status.active, true);
  assert.equal(status.online, true);
  assert.equal(status.deviceId, 'device-1');
  assert.equal(log.length, 1);
  assert.equal(log[0].gatewayOrigin, 'https://peer.example');
  assert.equal(log[0].deviceName, 'mac');
  // 状态里不得出现身份/密钥字段。lastFailure 是连接诊断（分类 + 错误码），
  // pairing 是待认领的挑战（用户必须能拿到才能绑定），两者都不含长期密钥材料。
  assert.deepEqual(
    Object.keys(status).sort(),
    ['active', 'connectionEpoch', 'deviceId', 'lastFailure', 'online', 'pairing', 'settings'],
  );
});

test('设置先落盘再连：连接失败时设置仍保留（意图可见）', async () => {
  const store = memorySettings();
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac',
    createSession: () => ({
      async start() { throw new Error('network down'); },
      stop() {},
      status: () => ({ online: false, deviceId: null, connectionEpoch: 0 }),
    }),
  });
  await assert.rejects(controller.update(valid), /network down/);
  assert.equal(store.raw().remoteAccess.enabled, true, '设置必须已持久化');
  assert.equal(controller.status().active, false, '启动失败后不应留下半死的会话');
});

test('相同设置重复 apply 不重连（幂等）', async () => {
  const log = [];
  const controller = createRemoteAccessController({
    settingsStore: memorySettings(), deviceName: 'mac', createSession: sessionFactory(log),
  });
  await controller.update(valid);
  await controller.apply();
  await controller.apply();
  assert.equal(log.length, 1, '同目标的重复 apply 不应新建会话');
});

test('换 Gateway 地址会重建会话', async () => {
  const log = [];
  const controller = createRemoteAccessController({
    settingsStore: memorySettings(), deviceName: 'mac', createSession: sessionFactory(log),
  });
  await controller.update(valid);
  await controller.update({ gatewayOrigin: 'https://other.example' });
  assert.equal(log.length, 2);
  assert.equal(log[0].stopped, true, '旧会话必须被停掉');
  assert.equal(log[1].gatewayOrigin, 'https://other.example');
});

test('关闭开关会停掉会话但保留设置值', async () => {
  const log = [];
  const store = memorySettings();
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory(log),
  });
  await controller.update(valid);
  const status = await controller.update({ enabled: false });
  assert.equal(status.active, false);
  assert.equal(log[0].stopped, true);
  assert.equal(store.raw().remoteAccess.gatewayOrigin, 'https://peer.example', '地址应保留便于再开');
});

test('并发 update 被串行化，不产生交错会话', async () => {
  const log = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = createRemoteAccessController({
    settingsStore: memorySettings(), deviceName: 'mac',
    createSession: ({ gatewayOrigin, workspaceId }) => {
      const record = { gatewayOrigin, workspaceId, stopped: false, started: 0 };
      log.push(record);
      return {
        async start() { record.started += 1; await gate; },
        stop() { record.stopped = true; },
        status: () => ({ online: false, deviceId: null, connectionEpoch: 0 }),
      };
    },
  });
  const first = controller.update(valid);
  const second = controller.update({ workspaceId: 'ws-2' });
  release();
  await Promise.all([first, second]);
  // 串行化确保第一个会话被完整建好并停掉之后，才建立第二个。
  assert.equal(log.length, 2);
  assert.equal(log[0].stopped, true);
  assert.equal(log[1].workspaceId, 'ws-2');
});

test('非法 patch 被拒绝且不写入设置', async () => {
  const store = memorySettings();
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory([]),
  });
  await assert.rejects(controller.update({ gatewayOrigin: 'ftp://x' }), /INVALID_GATEWAY_ORIGIN/);
  assert.deepEqual(store.raw(), {}, '非法输入不应落盘');
});

test('stop 只停连接，不动设置', async () => {
  const log = [];
  const store = memorySettings();
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory(log),
  });
  await controller.update(valid);
  const status = await controller.stop();
  assert.equal(status.active, false);
  assert.equal(store.raw().remoteAccess.enabled, true);
  assert.equal(controller.sessionTarget(), null);
});

test('status 在校验失败时也不抛错', () => {
  // 手工塞入损坏值，模拟外部编辑了设置文件。
  const store = memorySettings({ remoteAccess: { enabled: 'yes', gatewayOrigin: 42 } });
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory([]),
  });
  const status = controller.status();
  assert.equal(status.active, false);
  assert.deepEqual(status.settings, { enabled: false, gatewayOrigin: '', workspaceId: '' });
});

test('开启远程但没填 workspaceId 时用当前项目 id', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const log = [];
  const store = memorySettings({
    activeWorkspace: '/repo',
    workspaces: [{ id: projectId, path: '/repo', name: 'Repo' }],
  });
  const controller = createRemoteAccessController({
    settingsStore: store, deviceName: 'mac', createSession: sessionFactory(log),
  });
  await controller.update({ enabled: true, gatewayOrigin: 'https://peer.example' });
  assert.equal(log[0].workspaceId, projectId);
  assert.equal(store.raw().remoteAccess.workspaceId, projectId);
});

test('没有项目 id 时，缺 workspaceId 仍然不能开启远程', async () => {
  const controller = createRemoteAccessController({
    settingsStore: memorySettings(), deviceName: 'mac', createSession: sessionFactory([]),
  });
  await assert.rejects(
    controller.update({ enabled: true, gatewayOrigin: 'https://peer.example' }),
    /INCOMPLETE_REMOTE_SETTINGS/,
  );
});

test('构造期拒绝缺失依赖', () => {
  assert.throws(() => createRemoteAccessController({ deviceName: 'm', createSession: () => {} }), /INVALID_SETTINGS_STORE/);
  assert.throws(() => createRemoteAccessController({ settingsStore: memorySettings(), deviceName: 'm' }), /INVALID_CREATE_SESSION/);
});
