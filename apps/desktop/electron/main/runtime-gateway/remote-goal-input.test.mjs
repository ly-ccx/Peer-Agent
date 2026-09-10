import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteGoalReader } from './remote-goal-read.mjs';
const request = { protocolVersion: 1, type: 'task.submit', requestId: 'req', ownerId: 'owner', deviceId: 'device',
  workspaceId: 'workspace', bindingVersion: 1, connectionEpoch: 1, delegationVersion: 1,
  expiresAt: 2000, operation: 'task.read', taskId: 'task' };

for (const input of ['valid', 'write', 'extra-field', 'unsupported-version']) {
  for (const lookup of ['throws', 'missing']) {
    test(`remote-input-${input}-${lookup}`, async () => {
      let reads = 0; let executions = 0;
      const reader = createRemoteGoalReader({
        resolveLocal: async () => { reads++; if (lookup === 'throws') throw new Error('private database path'); return null; },
        getSession: () => { throw new Error('must not resolve session'); },
        getProjection: () => { throw new Error('must not resolve projection'); },
        host: { execute() { executions++; } },
      });
      const value = { ...request };
      if (input === 'write') value.operation = 'shell.execute';
      if (input === 'extra-field') value.path = '/private';
      if (input === 'unsupported-version') value.protocolVersion = 99;
      const result = await reader(value);
      assert.equal(result.ok, false);
      assert.equal(reads, input === 'valid' ? 1 : 0);
      assert.equal(executions, 0);
      if (input === 'valid') assert.deepEqual(result, { ok: false, code: 'LOCAL_STATE_UNAVAILABLE' });
      assert.equal(JSON.stringify(result).includes('private'), false);
    });
  }
}
