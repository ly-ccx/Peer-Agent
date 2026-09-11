import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountHttp } from './account-http.mjs';

/** Browser-facing read routing: authentication, strict input, and the mapping from
 * routing failure to status code. The route itself is a stand-in here; the real
 * relay over sockets is covered by task-routing.integration.test.mjs. */

const ORIGIN = 'https://peer.example';
const PROJECTION = { version: 2, workspaceIds: ['ws-1'], allowTaskRead: true, allowResultExport: true, expiresAt: 4_102_444_800_000 };

function createHarness({ authenticated = true, deviceTasks } = {}) {
  const handle = createAccountHttp({
    origin: ORIGIN,
    login: {},
    sessions: { authenticate: token => (authenticated && token === 'session-token' ? { ownerId: 'owner-1' } : null) },
    devices: { listDevices: () => [{ deviceId: 'device-1', name: 'Mac', revoked: false }] },
  });
  const calls = [];
  const tasks = deviceTasks === undefined
    ? {
        submit: async args => { calls.push(args); return { requestId: 'req-1', status: 'ok', result: { taskId: args.taskId } }; },
        describe: () => ({ ...PROJECTION }),
      }
    : deviceTasks;
  const send = (path, { method = 'GET', body, cookie = 'session-token', contentType, tasks: override } = {}) => handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(cookie ? { cookie: `__Host-peer_session=${cookie}` } : {}),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    { deviceTasks: override === undefined ? tasks : override },
  );
  return { send, calls };
}

const read = (harness, body, extra) => harness.send('/api/tasks/read', {
  method: 'POST', body, contentType: 'application/json', ...extra,
});

test('只读任务提交把参数交给路由并返回结果', async () => {
  const harness = createHarness();
  const response = await read(harness, { deviceId: 'device-1', workspaceId: 'ws-1', taskId: 'task-42' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requestId: 'req-1', status: 'ok', result: { taskId: 'task-42' } });
  // ownerId 来自会话，不接受请求体自带。
  assert.deepEqual(harness.calls, [{ ownerId: 'owner-1', deviceId: 'device-1', workspaceId: 'ws-1', taskId: 'task-42' }]);
});

test('未登录、非 JSON、字段不符分别被拒', async () => {
  const harness = createHarness();
  assert.equal((await read(harness, { deviceId: 'd', workspaceId: 'w', taskId: 't' }, { cookie: null })).status, 401);
  assert.equal((await harness.send('/api/tasks/read', { method: 'POST', body: '{}', contentType: 'text/plain' })).status, 415);
  assert.equal((await read(harness, { deviceId: 'd', workspaceId: 'w' })).status, 400);
  assert.equal((await read(harness, { deviceId: 'd', workspaceId: 'w', taskId: 't', ownerId: 'attacker' })).status, 400);
  assert.equal((await read(harness, 'not json')).status, 400);
  assert.equal(harness.calls.length, 0);
});

test('过大的请求体被拒，不会进入路由', async () => {
  const harness = createHarness();
  const response = await read(harness, { deviceId: 'd', workspaceId: 'w', taskId: 'x'.repeat(5000) });
  assert.equal(response.status, 413);
  assert.equal(harness.calls.length, 0);
});

test('路由失败映射为状态码，且不伪装成功', async () => {
  const cases = [['DEVICE_OFFLINE', 409], ['OUTCOME_UNKNOWN', 504], ['TASK_DENIED', 403],
    ['DELEGATION_UNAVAILABLE', 503], ['RATE_LIMITED', 429], ['SOMETHING_NEW', 502]];
  for (const [code, expected] of cases) {
    const harness = createHarness({ deviceTasks: {
      submit: async () => { throw new Error(code); },
      describe: () => null,
    } });
    const response = await read(harness, { deviceId: 'd', workspaceId: 'w', taskId: 't' });
    assert.equal(response.status, expected, `${code} should map to ${expected}`);
    const body = await response.json();
    assert.equal(body.error, 'TASK_UNAVAILABLE');
    assert.equal(body.code, code);
  }
});

test('未接设备传输时拒绝提交，而不是假装没有设备', async () => {
  const harness = createHarness();
  const response = await read(harness, { deviceId: 'd', workspaceId: 'w', taskId: 't' }, { tasks: null });
  assert.equal(response.status, 503);
});

test('委派视图只披露在线设备发布的投影', async () => {
  const harness = createHarness();
  const response = await harness.send('/api/delegations');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delegations: [{ deviceId: 'device-1', name: 'Mac', delegation: PROJECTION }] });
  assert.equal((await harness.send('/api/delegations', { cookie: null })).status, 401);
  const empty = createHarness({ deviceTasks: { submit: async () => {}, describe: () => null } });
  assert.deepEqual(await (await empty.send('/api/delegations')).json(), { delegations: [] });
});
