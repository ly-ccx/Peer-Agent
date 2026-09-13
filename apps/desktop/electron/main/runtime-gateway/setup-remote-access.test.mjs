import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRemoteAccess } from './setup-remote-access.mjs';

/** Each case gets a real (empty) data dir so the binding SQLite can open. */
const freshDir = () => mkdtempSync(join(tmpdir(), 'peer-remote-'));

/** In-memory stand-in for the keychain, so tests never touch the real one. */
function memoryIdentityStore(initial = null) {
  let value = initial;
  const writes = [];
  return {
    writes,
    current: () => value,
    isSupported: () => true,
    async loadSecret() { return value; },
    async saveSecret(next) { writes.push(next); value = next; },
    async deleteSecret() { const had = value !== null; value = null; return had; },
  };
}

/** Stub connector: records nothing, never dials. */
function stubConnector() {
  const stops = [];
  return { stop() { stops.push('stop'); }, closed: Promise.resolve({ reason: 'stopped' }), stops };
}

const CAPABILITY = { capabilityId: 'local.goal.get_plan', health: 'enabled' };

/** Projection must carry local.goal.get_plan, or the reader refuses the projection. */
const projection = () => ({ projectionId: 'projection-1', sessionId: 'session-1', capabilities: [CAPABILITY] });
const sessionStore = { getSession: () => ({ sessionId: 'session-1', locale: 'en-US' }) };

/** A plan whose nested task is the remote read target. */
const goalPlanStore = {
  listPlans: () => [{ planId: 'plan-42', subtasks: [{ taskId: 'task-99', subtasks: [] }] }],
};

/** A host that satisfies the reader's evidence contract: grant, result and
 * evidence must all agree on the toolCallId the reader generated. */
function createHost() {
  let calls = 0;
  return {
    calls: () => calls,
    async execute(event) {
      calls += 1;
      const id = event.call.toolCallId;
      return {
        grant: { toolCallId: id },
        result: { toolCallId: id, status: 'success', evidence: { toolCallId: id, artifactRefs: ['goal-plan://plan-42'] } },
      };
    },
  };
}

/** Build a setup instance; the connector factory captures the options it received. */
async function withConnection(overrides = {}) {
  const { host = createHost(), identityStore = memoryIdentityStore(), ...rest } = overrides;
  let captured = null;
  const remote = setupRemoteAccess({
    userDataPath: freshDir(),
    gatewayOrigin: 'https://peer.example',
    deviceName: 'test-mac',
    workspaceId: 'ws-1',
    goalPlanStore, sessionStore, buildProjection: projection, host,
    connectorFactory(options) { captured = options; return stubConnector(); },
    identityStore,
    ...rest,
  });
  await remote.start();
  return { remote, options: captured, host, identityStore };
}

/** Establish a binding the way the handshake would, then announce the connection. */
function bind(remote, options, { bindingVersion = 3, epoch = 7 } = {}) {
  remote.bindingStore.save({ origin: 'https://peer.example', deviceId: 'device-1', ownerId: 'owner-1', bindingVersion });
  options.onState({ status: 'online', connectionEpoch: epoch });
  return { bindingVersion, epoch };
}

const readRequest = ({ bindingVersion, epoch, taskId = 'task-99', workspaceId = 'ws-1',
  ownerId = 'owner-1', deviceId = 'device-1' }) => ({
  protocolVersion: 1, type: 'task.submit', requestId: 'req-1',
  ownerId, deviceId, workspaceId,
  bindingVersion, connectionEpoch: epoch, delegationVersion: 1,
  expiresAt: Date.now() + 10_000, operation: 'task.read', taskId,
});

test('未绑定时既不上线也不放行读取', async () => {
  const { remote, options } = await withConnection();
  assert.equal(remote.status().deviceId, null);
  assert.equal(remote.status().online, false);
  const answer = await options.onTaskRead(readRequest({ bindingVersion: 1, epoch: 1 }));
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.code, 'IDENTITY_UNBOUND');
});

test('已绑定且在线时返回本地任务状态与证据引用', async () => {
  const { remote, options, host } = await withConnection();
  const { bindingVersion, epoch } = bind(remote, options);
  assert.equal(remote.status().online, true);
  assert.equal(remote.status().connectionEpoch, epoch);

  const answer = await options.onTaskRead(readRequest({ bindingVersion, epoch }));
  assert.equal(answer.status, 'ok', JSON.stringify(answer));
  assert.equal(answer.result.taskId, 'task-99');
  assert.equal(answer.result.status, 'success');
  assert.deepEqual(answer.result.evidenceRefs, ['goal-plan://plan-42']);
  assert.equal(host.calls(), 1, '本地执行应当恰好发生一次');
});

test('本地没有这个任务时拒绝，且不触碰 host', async () => {
  const { remote, options, host } = await withConnection();
  const { bindingVersion, epoch } = bind(remote, options);
  const answer = await options.onTaskRead(readRequest({ bindingVersion, epoch, taskId: 'nope' }));
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.code, 'TASK_DENIED');
  assert.equal(host.calls(), 0);
});

test('请求的 owner/device 与本地绑定不符时拒绝', async () => {
  const { remote, options, host } = await withConnection();
  const { bindingVersion, epoch } = bind(remote, options);
  const forged = await options.onTaskRead(readRequest({ bindingVersion, epoch, ownerId: 'someone-else' }));
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.code, 'IDENTITY_UNBOUND');
  assert.equal(host.calls(), 0);
});

test('越界工作区被拒，不落到执行', async () => {
  const { remote, options, host } = await withConnection();
  const { bindingVersion, epoch } = bind(remote, options);
  const answer = await options.onTaskRead(readRequest({ bindingVersion, epoch, workspaceId: 'ws-other' }));
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.code, 'WORKSPACE_DENIED');
  assert.equal(host.calls(), 0);
});

test('断线后拒绝读取（不排队等待重连）', async () => {
  const { remote, options, host } = await withConnection();
  const { bindingVersion, epoch } = bind(remote, options);
  options.onState({ status: 'disconnected', reason: 'disconnected' });
  const answer = await options.onTaskRead(readRequest({ bindingVersion, epoch }));
  assert.equal(answer.status, 'rejected');
  assert.ok(['DEVICE_OFFLINE', 'IDENTITY_UNBOUND', 'LOCAL_STATE_UNAVAILABLE'].includes(answer.code), answer.code);
  assert.equal(host.calls(), 0);
});

test('能力未投影时拒绝执行', async () => {
  const { remote, options } = await withConnection({
    buildProjection: () => ({ projectionId: 'projection-1', sessionId: 'session-1', capabilities: [] }),
  });
  const { bindingVersion, epoch } = bind(remote, options);
  const answer = await options.onTaskRead(readRequest({ bindingVersion, epoch }));
  assert.equal(answer.status, 'rejected');
  assert.equal(answer.code, 'CAPABILITY_DENIED');
});

test('start 幂等，stop 后可以重新连接', async () => {
  let created = 0;
  const remote = setupRemoteAccess({
    userDataPath: freshDir(), gatewayOrigin: 'https://peer.example',
    deviceName: 'test-mac', workspaceId: 'ws-1',
    goalPlanStore, sessionStore, buildProjection: projection, host: createHost(),
    identityStore: memoryIdentityStore(),
    connectorFactory() { created += 1; return stubConnector(); },
  });
  await remote.start();
  await remote.start();
  assert.equal(created, 1, '重复 start 不应产生第二条连接');
  remote.stop();
  assert.equal(remote.status().online, false);
  await remote.start();
  assert.equal(created, 2, 'stop 之后允许重新连接');
});

test('下发给连接器的选项携带委派与回调', async () => {
  const { options } = await withConnection();
  assert.equal(options.origin, 'https://peer.example');
  assert.equal(typeof options.sign, 'function');
  assert.equal(typeof options.onTaskRead, 'function');
  assert.equal(typeof options.onState, 'function');
  assert.deepEqual(options.delegation.workspaceIds, ['ws-1']);
  assert.equal(options.delegation.allowTaskRead, true);
  assert.ok(options.delegation.expiresAt > Date.now());
  // 未绑定时不应凭空带上 deviceId。
  assert.equal(options.deviceId, undefined);
});

test('首次启动生成身份并写入钥匙串', async () => {
  const identityStore = memoryIdentityStore();
  const { options } = await withConnection({ identityStore });
  assert.equal(identityStore.writes.length, 1, '应写入一次身份');
  assert.match(identityStore.current(), /^[A-Za-z0-9+/=]+$/, '私钥以 base64 单行存储');
  assert.match(options.publicKey, /BEGIN PUBLIC KEY/);
});

test('重启后从钥匙串恢复同一身份（公钥不变）', async () => {
  // 第一次启动：生成并持久化。
  const identityStore = memoryIdentityStore();
  const first = await withConnection({ identityStore });
  const firstPublicKey = first.options.publicKey;

  // 模拟重启：同一钥匙串，全新的 setup 实例。
  const second = await withConnection({ identityStore });
  assert.equal(second.options.publicKey, firstPublicKey, '公钥必须跨重启保持一致');
  assert.equal(identityStore.writes.length, 1, '恢复路径不应再次写入');
});

test('钥匙串内容损坏时清掉并拒绝，不静默降级', async () => {
  const identityStore = memoryIdentityStore(Buffer.from('short').toString('base64'));
  const remote = setupRemoteAccess({
    userDataPath: freshDir(), gatewayOrigin: 'https://peer.example',
    deviceName: 'test-mac', workspaceId: 'ws-1',
    goalPlanStore, sessionStore, buildProjection: projection, host: createHost(),
    identityStore,
    connectorFactory() { return stubConnector(); },
  });
  await assert.rejects(remote.start(), /INVALID_KEYCHAIN_KEY/);
  assert.equal(identityStore.current(), null, '损坏条目应被清除，避免每次启动都失败');
});

test('签名可被对应公钥验证（身份真的可用）', async () => {
  const { options } = await withConnection();
  const { createPublicKey, verify } = await import('node:crypto');
  const message = Buffer.from('handshake-challenge');
  const signature = Buffer.from(await options.sign(message.toString()), 'base64url');
  assert.ok(verify(null, message, createPublicKey(options.publicKey), signature), '签名必须验证通过');
});

test('连接放弃时把失败原因报给状态读取方，而不是永远停在连接中', async () => {
  // Regression: the supervisor resolved when it gave up, but nothing consumed
  // that, so status() kept reporting active=true with no reason. The settings
  // panel showed "connecting…" forever for a dial that had already failed.
  let resolveClosed;
  const failing = {
    stop() {},
    closed: new Promise(resolve => { resolveClosed = resolve; }),
  };
  const remote = setupRemoteAccess({
    userDataPath: freshDir(), gatewayOrigin: 'https://peer.example',
    deviceName: 'test-mac', workspaceId: 'ws-1',
    goalPlanStore, sessionStore, buildProjection: projection, host: createHost(),
    identityStore: memoryIdentityStore(),
    connectorFactory() { return failing; },
  });
  await remote.start();
  assert.equal(remote.status().lastFailure, null, '拨号期间不算失败');

  resolveClosed({ reason: 'transport_failure', detail: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
  await new Promise(resolve => setImmediate(resolve));

  const failure = remote.status().lastFailure;
  assert.equal(failure.reason, 'transport_failure');
  assert.equal(failure.code, 'SELF_SIGNED_CERT_IN_CHAIN', '原始错误码必须保留，否则无法给出可操作的提示');
  assert.equal(remote.status().online, false);
});

test('主动停止会清掉失败原因，不让旧原因冒充新状态', async () => {
  let resolveClosed;
  const failing = {
    stop() {},
    closed: new Promise(resolve => { resolveClosed = resolve; }),
  };
  const remote = setupRemoteAccess({
    userDataPath: freshDir(), gatewayOrigin: 'https://peer.example',
    deviceName: 'test-mac', workspaceId: 'ws-1',
    goalPlanStore, sessionStore, buildProjection: projection, host: createHost(),
    identityStore: memoryIdentityStore(),
    connectorFactory() { return failing; },
  });
  await remote.start();
  resolveClosed({ reason: 'transport_failure', detail: { code: 'ENOTFOUND' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(remote.status().lastFailure, '先确认失败已被记录');

  remote.stop();
  assert.equal(remote.status().lastFailure, null, '停止后不应残留上一次的失败原因');
});
