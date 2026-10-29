import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteAccessIpcRegistrations } from './register-remote-access-ipc.mjs';
function handlers(controller) { const map = new Map(); for (const row of createRemoteAccessIpcRegistrations({ getRemoteAccess: () => controller })) row.register({ handle: (key, handler) => map.set(key, handler) }); return map; }
test('idle remote DTO starts with no grants and no activity', () => {
  const result = handlers(null).get('remote-access:status')();
  assert.equal(result.ok, true); assert.deepEqual(result.status.settings.projectGrants, []); assert.equal(result.status.settings.delegationVersion, 1); assert.equal(result.status.lastAccess, null);
});
test('remote update rejects unknown or malformed fields before calling controller', async () => {
  let calls = 0; const update = handlers({ update: async patch => { calls++; return patch; } }).get('remote-access:update');
  for (const patch of [null, [], {}, { delegationVersion: 2 }, { enabled: 'yes' }, { gatewayOrigin: 42 }, { workspaceIds: [] }, { projectGrants: {} }, { projectGrants: Array(201).fill({}) }, { workspaceId: 'a'.repeat(129) }]) {
    assert.deepEqual(await update(null, patch), { ok: false, error: 'INVALID_REMOTE_PATCH' });
  }
  assert.equal(calls, 0);
  const patch = { projectGrants: [{ workspaceId: 'a', allowProjectRead: true, allowProjectMessage: false }] };
  assert.deepEqual(await update(null, patch), { ok: true, status: patch }); assert.equal(calls, 1);
});
