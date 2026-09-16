import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';
import { createNodeRuntimeHostAdapter } from '@peer-agent/runtime-node';
import { createCapabilityProviderRegistry } from './capability-provider-registry.mjs';
import { createLocalGoalProvider } from './local-goal-provider.mjs';
import { createPermissionGrant, createFailedClientToolResult as createFailedResult } from './tool-result-factory.mjs';
import { createRemoteGoalReader } from './remote-goal-read.mjs';

for (const revoked of [false, true]) {
  test(`remote-read-real-runtime-revoked-${revoked}`, async () => {
    let reads = 0;
    const provider = createLocalGoalProvider({ goalPlanStore: {
      async getPlan(planId) {
        reads++;
        return { planId, title: 'isolated fixture', goal: 'read fixture', tasks: [], status: 'executing' };
      },
    } });
    const registry = createCapabilityProviderRegistry({ providers: [provider] });
    const session = { sessionId: 'session', locale: 'en-US' };
    const runtime = createRuntimeSdk({ host: createNodeRuntimeHostAdapter({
      providerExecutor: registry, sessionProvider: { getSession: () => session },
      resultFactory: { createPermissionGrant, createFailedResult },
    }) });
    const request = { protocolVersion: 1, type: 'task.submit', requestId: 'runtime-proof',
      ownerId: 'owner', deviceId: 'device', workspaceId: 'workspace', bindingVersion: 1,
      connectionEpoch: 1, delegationVersion: 1, expiresAt: 2000, operation: 'task.read', taskId: 'task' };
    const reader = createRemoteGoalReader({ host: runtime, getSession: () => session,
      getProjection: () => ({ projectionId: 'projection', capabilities: [{ capabilityId: 'local.goal.get_plan', health: 'healthy' }] }),
      resolveLocal: async () => ({ planId: 'fixture-plan', taskId: 'task', executionContext: {},
        admission: { now: 1000, ownerId: 'owner', deviceId: 'device', bindingVersion: 1,
          connectionEpoch: 1, online: true, bindingRevoked: revoked,
          delegation: { version: 1, expiresAt: 3000, revoked: false, workspaceIds: ['workspace'], allowTaskRead: true, allowResultExport: true },
          task: { taskId: 'task', ownerId: 'owner', workspaceId: 'workspace' } } }),
    });
    const output = await reader(request);
    if (revoked) {
      assert.equal(output.ok, false); assert.equal(reads, 0);
    } else {
      assert.equal(output.ok, true, JSON.stringify(output));
      assert.equal(reads, 1);
      assert.equal(output.execution.grant.granted, true);
      assert.equal(output.execution.result.status, 'success');
      assert.equal(output.execution.result.evidence.toolCallId, 'remote-runtime-proof');
      assert.ok(output.execution.result.evidence.artifactRefs.includes('goal-plan://fixture-plan'));
    }
  });
}
