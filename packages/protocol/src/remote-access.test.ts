import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRemoteRead, parseRemoteReadRequest, type RemoteReadContext, type RemoteReadRequest } from './remote-access.ts';

const request: RemoteReadRequest = {
  protocolVersion: 1, type: 'task.submit', requestId: 'request-1', ownerId: 'owner-1',
  deviceId: 'device-1', workspaceId: 'workspace-1', bindingVersion: 1,
  connectionEpoch: 2, delegationVersion: 3, expiresAt: 20_000,
  operation: 'task.read', taskId: 'task-1',
};
function context(): RemoteReadContext {
  return {
    now: 10_000, ownerId: 'owner-1', deviceId: 'device-1', bindingVersion: 1,
    connectionEpoch: 2, online: true, bindingRevoked: false,
    delegation: { version: 3, expiresAt: 60_000, revoked: false,
      workspaceIds: ['workspace-1'], allowTaskRead: true, allowResultExport: true },
    task: { taskId: 'task-1', ownerId: 'owner-1', workspaceId: 'workspace-1' },
  };
}

// Explicit identity × delegation × connection cross-product (12 cells).
for (const identity of ['owner', 'other'] as const) {
  for (const permission of ['allowed', 'revoked', 'no-export'] as const) {
    for (const connection of ['online', 'offline'] as const) {
      test(`M1-${identity}-${permission}-${connection}`, () => {
        const c = context();
        const result = admitRemoteRead({ ...request, ownerId: identity === 'owner' ? 'owner-1' : 'other' }, {
          ...c, online: connection === 'online',
          delegation: { ...c.delegation, revoked: permission === 'revoked', allowResultExport: permission !== 'no-export' },
        });
        const code = identity === 'other' ? 'IDENTITY_UNBOUND'
          : permission === 'revoked' ? 'DELEGATION_EXPIRED'
          : permission === 'no-export' ? 'EXPORT_DENIED'
          : connection === 'offline' ? 'DEVICE_OFFLINE' : null;
        if (code) assert.deepEqual(result, { ok: false, code });
        else assert.deepEqual(result, { ok: true, request });
      });
    }
  }
}

test('strict M1 parser rejects writes, arbitrary fields, paths and unsupported versions', () => {
  for (const value of [null, [], {}, { ...request, operation: 'shell.execute' },
    { ...request, args: { command: 'pwd' } }, { ...request, workspaceId: '/tmp' },
    { ...request, bindingVersion: NaN }, { ...request, expiresAt: Infinity },
    { ...request, protocolVersion: 2 }, { ...request, requestId: '' }]) {
    assert.equal(parseRemoteReadRequest(value).ok, false);
  }
});

test('connection epoch, binding, task ownership and workspace are independently enforced', () => {
  const c = context();
  const cases: [Partial<RemoteReadContext>, string][] = [
    [{ connectionEpoch: 3 }, 'STALE_CONNECTION'],
    [{ bindingVersion: 2 }, 'IDENTITY_UNBOUND'],
    [{ bindingRevoked: true }, 'IDENTITY_UNBOUND'],
    [{ deviceId: 'different' }, 'IDENTITY_UNBOUND'],
    [{ task: null }, 'TASK_DENIED'],
    [{ task: { taskId: 'task-1', ownerId: 'other', workspaceId: 'workspace-1' } }, 'TASK_DENIED'],
    [{ task: { taskId: 'task-1', ownerId: 'owner-1', workspaceId: 'other' } }, 'TASK_DENIED'],
    [{ delegation: { ...c.delegation, workspaceIds: [] } }, 'WORKSPACE_DENIED'],
    [{ delegation: { ...c.delegation, allowTaskRead: false } }, 'CAPABILITY_DENIED'],
    [{ delegation: { ...c.delegation, version: 4 } }, 'DELEGATION_EXPIRED'],
    [{ delegation: { ...c.delegation, expiresAt: c.now } }, 'DELEGATION_EXPIRED'],
  ];
  for (const [patch, code] of cases) assert.deepEqual(admitRemoteRead(request, { ...c, ...patch }), { ok: false, code });
});

test('new submissions have a bounded lifetime, invalid clocks fail closed', () => {
  for (const expiresAt of [10_000, 9_999, 40_001]) {
    assert.deepEqual(admitRemoteRead({ ...request, expiresAt }, context()), { ok: false, code: 'REQUEST_EXPIRED' });
  }
  assert.equal(admitRemoteRead({ ...request, expiresAt: 40_000 }, context()).ok, true);
  assert.equal(admitRemoteRead(request, { ...context(), now: NaN }).ok, false);
});

test('parsing snapshots scalar fields rather than retaining caller mutable object', () => {
  const input = { ...request };
  const result = parseRemoteReadRequest(input);
  input.ownerId = 'changed';
  assert.equal(result.ok && result.request.ownerId, 'owner-1');
});
