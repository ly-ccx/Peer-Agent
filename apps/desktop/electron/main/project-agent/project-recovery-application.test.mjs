import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';

test('recovery commands require the local project scope and never go through chat input submission', async () => {
  const calls = [];
  const service = createProjectAgentApplicationService({ enabled: () => true,
    directory: { get: id => ({ ok: id === 'owned' }) },
    inputQueue: { enqueue() { assert.fail('maintenance is not a new user input'); } },
    recoveryControl: { execute: input => { calls.push(input); return { ok: true, view: { phase: 'inspection' } }; } } });
  assert.equal((await service.controlRecovery({ workspaceId: 'other', action: 'restore' })).code, 'NOT_FOUND');
  assert.deepEqual(calls, []);
  const request = { workspaceId: 'owned', action: 'inspect' };
  assert.equal((await service.controlRecovery(request)).ok, true);
  assert.deepEqual(calls, [request]);
  service.dispose?.();
});
