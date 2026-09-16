import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteTaskRouter } from './remote-task-router.mjs';

const AT = 1_000;

function createHarness({ delegation, route } = {}) {
  const sent = [];
  const base = {
    version: 3, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true,
    expiresAt: AT + 60_000,
  };
  const connections = {
    route: route ?? ((ownerId, deviceId) => ({
      handle: { deviceId, connectionId: 'connection-1', epoch: 7 },
      bindingVersion: 4,
      delegation: delegation === undefined ? base : delegation,
      send: message => sent.push(message),
    })),
  };
  const router = createRemoteTaskRouter({ connections, now: () => AT, answerTimeoutMs: 40, requestTtlMs: 100 });
  return { router, sent };
}

const submitArgs = { ownerId: 'owner-1', deviceId: 'device-1', workspaceId: 'ws-1', taskId: 'task-1' };

test('提交的请求符合只读协议字段，版本与工作区来自设备投影', async () => {
  const { router, sent } = createHarness();
  const answer = router.submit(submitArgs);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: 'remote.task.request',
    protocolVersion: 1,
    request: {
      protocolVersion: 1, type: 'task.submit', requestId: sent[0].request.requestId,
      ownerId: 'owner-1', deviceId: 'device-1', workspaceId: 'ws-1',
      bindingVersion: 4, connectionEpoch: 7, delegationVersion: 3,
      expiresAt: AT + 100, operation: 'task.read', taskId: 'task-1',
    },
  });
  // 请求是一次性的：不得重放，同样内容不能出现第二次。
  router.settle({ requestId: sent[0].request.requestId, status: 'ok', result: { ok: true } });
  await answer;
  assert.equal(sent.length, 1);
});

test('设备确认后把结果交给调用方', async () => {
  const { router, sent } = createHarness();
  const answer = router.submit(submitArgs);
  const requestId = sent[0].request.requestId;
  assert.equal(router.settle({ requestId, status: 'ok', result: { taskId: 'task-1', state: 'running' } }), true);
  assert.deepEqual(await answer, { requestId, status: 'ok', result: { taskId: 'task-1', state: 'running' } });
  assert.equal(router.pendingCount(), 0);
});

test('设备拒绝时带出稳定错误码', async () => {
  const { router, sent } = createHarness();
  const answer = router.submit(submitArgs);
  router.settle({ requestId: sent[0].request.requestId, status: 'rejected', code: 'TASK_DENIED' });
  await assert.rejects(answer, /TASK_DENIED/);
});

test('设备未上线时拒绝提交，且不发送任何请求', async () => {
  const { router } = createHarness({ route: () => { throw new Error('DEVICE_OFFLINE'); } });
  await assert.rejects(router.submit(submitArgs), /DEVICE_OFFLINE/);
});

test('缺少委派投影时拒绝：投影也是设备就绪的门槛', async () => {
  const { router, sent } = createHarness({ delegation: null });
  await assert.rejects(router.submit(submitArgs), /DELEGATION_UNAVAILABLE/);
  assert.equal(sent.length, 0);
});

test('委派过期、越界工作区、未开放读取分别拒绝', async () => {
  const expired = createHarness({ delegation: {
    version: 3, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true, expiresAt: AT,
  } });
  await assert.rejects(expired.router.submit(submitArgs), /DELEGATION_EXPIRED/);

  const otherWorkspace = createHarness({ delegation: {
    version: 3, workspaceIds: ['ws-9'], allowTaskRead: true, allowResultExport: true, expiresAt: AT + 60_000,
  } });
  await assert.rejects(otherWorkspace.router.submit(submitArgs), /WORKSPACE_DENIED/);

  const readClosed = createHarness({ delegation: {
    version: 3, workspaceIds: ['ws-1'], allowTaskRead: false, allowResultExport: true, expiresAt: AT + 60_000,
  } });
  await assert.rejects(readClosed.router.submit(submitArgs), /CAPABILITY_DENIED/);
});

test('超时是 OUTCOME_UNKNOWN，不是失败：设备可能已经执行', async () => {
  const { router, sent } = createHarness();
  const answer = router.submit(submitArgs);
  const requestId = sent[0].request.requestId;
  await assert.rejects(answer, /OUTCOME_UNKNOWN/);
  // 迟到的回答被丢弃，而不是抛错或重新入队。
  assert.equal(router.settle({ requestId, status: 'ok', result: {} }), false);
  assert.equal(router.pendingCount(), 0);
});

test('写失败按设备不可用处理，不留下悬挂的待办', async () => {
  const { router } = createHarness();
  const connections = {
    route: () => ({
      handle: { deviceId: 'device-1', connectionId: 'connection-1', epoch: 7 },
      bindingVersion: 4,
      delegation: { version: 3, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true, expiresAt: AT + 60_000 },
      send: () => { throw new Error('DEVICE_UNAVAILABLE'); },
    }),
  };
  const broken = createRemoteTaskRouter({ connections, now: () => AT, answerTimeoutMs: 40, requestTtlMs: 100 });
  await assert.rejects(broken.submit(submitArgs), /DEVICE_UNAVAILABLE/);
  assert.equal(broken.pendingCount(), 0);
  await assert.rejects(router.submit({ ...submitArgs, taskId: '' }), /INVALID_REQUEST/);
});

test('并发上限拒绝新提交，close 让未决请求落到 OUTCOME_UNKNOWN', async () => {
  const { router, sent } = createHarness();
  const connections = {
    route: () => ({
      handle: { deviceId: 'device-1', connectionId: 'connection-1', epoch: 7 },
      bindingVersion: 4,
      delegation: { version: 3, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true, expiresAt: AT + 60_000 },
      send: message => sent.push(message),
    }),
  };
  const bounded = createRemoteTaskRouter({ connections, now: () => AT, limit: 1, answerTimeoutMs: 40, requestTtlMs: 100 });
  const first = bounded.submit(submitArgs);
  await assert.rejects(bounded.submit(submitArgs), /RATE_LIMITED/);
  bounded.close();
  await assert.rejects(first, /OUTCOME_UNKNOWN/);
  await assert.rejects(router.submit(submitArgs), /OUTCOME_UNKNOWN|INVALID_REQUEST/);
});

test('构造期拒绝会产出设备必然拒绝的请求配置', () => {
  const connections = { route: () => ({}) };
  assert.throws(() => createRemoteTaskRouter({ connections, requestTtlMs: 30_001 }), /INVALID_ROUTER_CONFIG/);
  assert.throws(() => createRemoteTaskRouter({ connections, requestTtlMs: 100, answerTimeoutMs: 200 }), /INVALID_ROUTER_CONFIG/);
  assert.throws(() => createRemoteTaskRouter({ connections: {}, now: () => AT }), /INVALID_ROUTER_CONFIG/);
});
