import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWorkSessionWrite, readOnlyWorkCapabilityAllowed } from '../project-agent/session-supervisor.mjs';
import { executionIdentity } from '../project-agent/session-control-kernel.mjs';
import { evaluateProjectAgentTurn } from '../project-agent/mode-policy.mjs';
import { agentCommunicationExcludedPrefixes } from '../project-agent/work-session-profile.mjs';
import { interactiveCapabilitiesForProfile } from './role-policy.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const worker = { role: 'work_session', agentKind: 'worker' };
const plan = { planId: 'plan-a', conversationId: 'worker-a', createdAt: '2026-11-03T00:00:00Z',
  delegationOrigin: { readOnly: true, workspaceId: 'bot-a', parentConversationId: 'parent-a', sessionId: 'session-a', phase: 'running' } };
test('readOnly inventory and actual execution share the precise worker internal-publication exception', () => {
  const action = { capabilityId: PUBLISH, riskLevel: 'L2_local_write', turnProfile: worker, executionIdentity: executionIdentity(plan) };
  assert.equal(readOnlyWorkCapabilityAllowed(action), true); assert.deepEqual(evaluateWorkSessionWrite(plan, action), { allowed: true });
  assert.equal(evaluateWorkSessionWrite(plan, { ...action, executionIdentity: undefined }).error, 'interactive_execution_stale');
  assert.equal(evaluateWorkSessionWrite(plan, { ...action, executionIdentity: { ...action.executionIdentity, executionEpoch: 'old-epoch' } }).error, 'execution_revision_stale');
  assert.equal(evaluateWorkSessionWrite(plan, { ...action, permissionKind: 'file-write' }).error, 'read_only');
  assert.equal(readOnlyWorkCapabilityAllowed({ ...action, riskLevel: 'L5_destructive' }), false);
  for (const capabilityId of ['local.file.write', 'local.file.edit', 'local.shell.exec', 'local.mcp.write']) {
    assert.equal(readOnlyWorkCapabilityAllowed({ ...action, capabilityId, riskLevel: 'L2_local_write' }), false);
  }
});
test('main Bot, Explorer and Verifier cannot publish even if a projection accidentally exposes the capability', () => {
  for (const turnProfile of [{ role: 'project_agent' }, { role: 'work_session', agentKind: 'explorer' }, { role: 'work_session', agentKind: 'verifier' }, null]) {
    assert.equal(readOnlyWorkCapabilityAllowed({ capabilityId: PUBLISH, turnProfile }), false);
    assert.equal(evaluateWorkSessionWrite({ ...plan, delegationOrigin: { ...plan.delegationOrigin, readOnly: false } },
      { capabilityId: PUBLISH, turnProfile, executionIdentity: executionIdentity(plan) }).error, 'interactive_role_denied');
  }
  assert.equal(evaluateProjectAgentTurn({ mode: 'project_agent', capabilityId: PUBLISH }).allowed, false);
  assert.equal(evaluateProjectAgentTurn({ mode: 'project_agent', capabilityId: INSPECT }).allowed, true);
});
test('role prefixes preserve normal reads while admitting only bounded inspection roles', () => {
  assert.equal(readOnlyWorkCapabilityAllowed({ capabilityId: 'local.file.read' }), true);
  assert.equal(readOnlyWorkCapabilityAllowed({ capabilityId: 'local.git.query' }), true);
  for (const turnProfile of [{ role: 'project_agent' }, { role: 'work_session', agentKind: 'verifier' }]) {
    assert.equal(readOnlyWorkCapabilityAllowed({ capabilityId: INSPECT, turnProfile }), true);
    assert.ok(agentCommunicationExcludedPrefixes(turnProfile).includes(PUBLISH));
    assert.equal(agentCommunicationExcludedPrefixes(turnProfile).includes(INSPECT), false);
  }
  assert.deepEqual(interactiveCapabilitiesForProfile(null), []);
  assert.ok(agentCommunicationExcludedPrefixes(null).includes(INSPECT));
});
