import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteGoalReader } from './remote-goal-read.mjs';

for (const change of ['none', 'revoke', 'no-export', 'owner', 'plan', 'lookup-error', 'projection']) {
  test(`remote-read-post-execution-${change}`, async () => {
    let executed = false;
    const local = () => ({ planId: executed && change === 'plan' ? 'other' : 'plan', taskId: 'task', executionContext: {},
      admission: { now: 1000, ownerId: 'owner', deviceId: 'device', bindingVersion: 1,
        connectionEpoch: 1, online: true, bindingRevoked: executed && change === 'revoke',
        delegation: { version: 1, expiresAt: 3000, revoked: false, workspaceIds: ['workspace'],
          allowTaskRead: true, allowResultExport: !(executed && change === 'no-export') },
        task: { taskId: 'task', ownerId: executed && change === 'owner' ? 'other' : 'owner', workspaceId: 'workspace' } } });
    const reader = createRemoteGoalReader({
      resolveLocal: async () => { if (executed && change === 'lookup-error') throw new Error('private path'); return local(); },
      getSession: () => ({ sessionId: 'session' }),
      getProjection: () => ({ projectionId: 'projection', capabilities: executed && change === 'projection' ? []
        : [{ capabilityId: 'local.goal.get_plan', health: 'healthy' }] }),
      host: { async execute(event) {
        executed = true;
        return { grant: { toolCallId: event.call.toolCallId }, result: { toolCallId: event.call.toolCallId,
          output: 'private task content', evidence: { toolCallId: event.call.toolCallId } } };
      } },
    });
    const result = await reader(request);
    assert.equal(executed, true);
    if (change === 'none') assert.equal(result.execution.result.output, 'private task content');
    else assert.deepEqual(result, { ok: false, code: 'RESULT_EXPORT_DENIED' });
  });
}

const request = { protocolVersion: 1, type: 'task.submit', requestId: 'req', ownerId: 'owner', deviceId: 'device',
  workspaceId: 'workspace', bindingVersion: 1, connectionEpoch: 1, delegationVersion: 1,
  expiresAt: 2000, operation: 'task.read', taskId: 'task' };
for (const permission of ['allowed', 'revoked']) {
  for (const projection of ['present', 'absent', 'disabled']) {
    test(`remote-read-${permission}-${projection}`, async () => {
      let calls = 0;
      const context = { toolContext: { conversationId: 'conversation' } };
      const read = createRemoteGoalReader({
        resolveLocal: async () => ({ planId: 'local-plan', taskId: 'task', executionContext: context,
          admission: { now: 1000, ownerId: 'owner', deviceId: 'device', bindingVersion: 1,
            connectionEpoch: 1, online: true, bindingRevoked: false,
            delegation: { version: 1, expiresAt: 3000, revoked: permission === 'revoked',
              workspaceIds: ['workspace'], allowTaskRead: true, allowResultExport: true },
            task: { taskId: 'task', ownerId: 'owner', workspaceId: 'workspace' } } }),
        getSession: () => ({ sessionId: 'session' }),
        getProjection: () => ({ projectionId: 'projection', capabilities: projection === 'absent' ? []
          : [{ capabilityId: 'local.goal.get_plan', health: projection === 'disabled' ? 'policy_disabled' : 'healthy' }] }),
        host: { async execute(event, executionContext) {
          calls++;
          assert.equal(executionContext, context);
          assert.deepEqual(event.call.arguments, { planId: 'local-plan' });
          assert.equal(event.sessionId, 'session');
          assert.equal(event.projectionId, 'projection');
          // Test execution double; not real runtime Evidence.
          return { grant: { toolCallId: event.call.toolCallId }, result: { toolCallId: event.call.toolCallId,
            evidence: { toolCallId: event.call.toolCallId } } };
        } },
      });
      const result = await read(request);
      const expected = permission === 'allowed' && projection === 'present';
      assert.equal(result.ok, expected);
      assert.equal(calls, expected ? 1 : 0);
    });
  }
}
