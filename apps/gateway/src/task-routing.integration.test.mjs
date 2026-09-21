import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDeviceStore } from './device-store.mjs';
import { createGatewayHttpServer } from './http-server.mjs';
import { createAccountHttp } from './account-http.mjs';
import { createRemoteBindingStore } from '../../../packages/runtime-node/src/remote-binding-store.mjs';
import { connectRemoteDevice } from '../../../packages/runtime-node/src/remote-device-connection.mjs';

/** Read-only routing over real sockets: submit → Gateway relay → device handler →
 * answer → caller. The identity provider is a key pair and the local runtime is a
 * handler stand-in; everything else, including the handshake and both stores, is real. */

const ORIGIN = 'https://peer.example';
const delegation = () => ({
  version: 1, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true,
  expiresAt: Date.now() + 3_600_000,
});

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function pairAndConnect(t, { grant = delegation(), onTaskRead, alreadyPaired = false } = {}) {
  const remote = createDeviceStore(':memory:');
  const local = createRemoteBindingStore(':memory:');
  const server = createGatewayHttpServer({
    origin: ORIGIN, deviceStore: remote, handle: async () => new Response(null, { status: 404 }),
  });
  const address = await server.listen();
  const sockets = []; const clients = [];
  t.after(async () => {
    for (const client of clients) client.stop();
    for (const socket of sockets) socket.terminate();
    await server.close(); local.close(); remote.close();
  });
  const keys = generateKeyPairSync('ed25519');
  const base = {
    origin: ORIGIN,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    name: 'Mac',
    store: { load: () => local.load(), save: value => local.save(value) },
    sign: async message => sign(null, Buffer.from(message), keys.privateKey).toString('base64url'),
    socketFactory(url) {
      assert.equal(url, 'wss://peer.example/api/device/ws');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/device/ws`, { headers: { host: 'peer.example' } });
      sockets.push(socket); return socket;
    },
  };
  let deviceId;
  if (!alreadyPaired) {
    const first = connectRemoteDevice({ ...base, onState(event) {
      if (event.status === 'pairing') {
        deviceId = event.pairing.deviceId;
        remote.claimPairing('owner', event.pairing.challengeId, event.pairing.pairingKey);
      }
    } });
    clients.push(first);
    assert.equal((await first.closed).reason, 'reconnect');
  }
  let onlineResolve;
  const online = new Promise(resolve => { onlineResolve = resolve; });
  const device = connectRemoteDevice({
    ...base, delegation: grant, onTaskRead,
    onState(event) { if (event.status === 'online') onlineResolve(event); },
  });
  clients.push(device);
  await online;
  const routeOf = () => {
    try { return server.deviceTransport.connections.route('owner', deviceId); }
    catch { return null; }
  };
  return { remote, local, server, address, deviceId, device, routeOf, clients, sockets };
}

test('只读任务经 Gateway 到设备再带结果回来', { timeout: 8000 }, async t => {
  const { server, deviceId, routeOf } = await pairAndConnect(t, {
    onTaskRead: async request => {
      assert.equal(request.operation, 'task.read');
      assert.equal(request.taskId, 'task-42');
      return { status: 'ok', result: { taskId: 'task-42', state: 'running' } };
    },
  });
  // 委派投影在握手后单独上报，等到它可见再提交。
  const projection = await waitFor(() => routeOf()?.delegation);
  assert.equal(projection.version, 1);
  assert.deepEqual(projection.workspaceIds, ['ws-1']);
  const answer = await server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.result, { taskId: 'task-42', state: 'running' });
});

test('设备未上报委派投影时拒绝路由', { timeout: 8000 }, async t => {
  const { server, deviceId } = await pairAndConnect(t, { grant: null });
  await assert.rejects(server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  }), /DELEGATION_UNAVAILABLE/);
});

test('设备侧拒绝时把码带回来，不伪装成成功', { timeout: 8000 }, async t => {
  const { server, deviceId, routeOf } = await pairAndConnect(t, {
    onTaskRead: async () => ({ status: 'rejected', code: 'TASK_DENIED' }),
  });
  await waitFor(() => routeOf()?.delegation);
  await assert.rejects(server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  }), /TASK_DENIED/);
});

test('设备没有配置读取能力时返回 CAPABILITY_DENIED', { timeout: 8000 }, async t => {
  const { server, deviceId, routeOf } = await pairAndConnect(t, { onTaskRead: undefined });
  await waitFor(() => routeOf()?.delegation);
  await assert.rejects(server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  }), /CAPABILITY_DENIED/);
});

test('超出帧上限的结果被拒发，而不是截断', { timeout: 8000 }, async t => {
  const { server, deviceId, routeOf } = await pairAndConnect(t, {
    onTaskRead: async () => ({ status: 'ok', result: { blob: 'x'.repeat(4000) } }),
  });
  await waitFor(() => routeOf()?.delegation);
  await assert.rejects(server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  }), /RESULT_TOO_LARGE/);
});

test('设备离线后不再受理，也不排队等待上线', { timeout: 8000 }, async t => {
  const { server, deviceId, device, routeOf } = await pairAndConnect(t, {
    onTaskRead: async () => ({ status: 'ok', result: {} }),
  });
  await waitFor(() => routeOf()?.delegation);
  device.stop();
  await waitFor(() => !routeOf());
  await assert.rejects(server.deviceTransport.router.submit({
    ownerId: 'owner', deviceId, workspaceId: 'ws-1', taskId: 'task-42',
  }), /DEVICE_OFFLINE|DEVICE_UNAVAILABLE/);
});

test('浏览器经 HTTP 提交只读任务，完整链路带回结果', { timeout: 8000 }, async t => {
  const { server, deviceId, routeOf } = await pairAndConnect(t, {
    onTaskRead: async request => ({ status: 'ok', result: { taskId: request.taskId, state: 'done' } }),
  });
  await waitFor(() => routeOf()?.delegation);
  const account = createAccountHttp({
    origin: ORIGIN,
    login: {},
    sessions: { authenticate: token => (token === 'session-token' ? { ownerId: 'owner' } : null) },
    devices: { listDevices: () => [{ deviceId, name: 'Mac', revoked: false }] },
  });
  const call = (path, options = {}) => account(new Request(`${ORIGIN}${path}`, options), {
    deviceConnections: server.deviceTransport.connections,
    deviceTasks: server.deviceTransport.router,
  });
  // 页面先取委派视图来填工作区，再提交一次读取。
  const view = await call('/api/delegations', { headers: { cookie: '__Host-peer_session=session-token' } });
  assert.equal(view.status, 200);
  assert.deepEqual((await view.json()).delegations[0].delegation.workspaceIds, ['ws-1']);
  const response = await call('/api/tasks/read', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: '__Host-peer_session=session-token' },
    body: JSON.stringify({ deviceId, workspaceId: 'ws-1', taskId: 'task-7' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.result, { taskId: 'task-7', state: 'done' });
});
