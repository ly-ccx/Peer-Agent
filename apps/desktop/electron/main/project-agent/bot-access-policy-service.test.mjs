import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotAccessPolicyService } from './bot-access-policy-service.mjs';
import { getDesktopIpcPolicy } from '../../ipc/channels.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';

test('only a persisted policy receipt is published; invalid reads and disabled writes never reach authority', () => {
  const writes = [], events = [];
  let enabled = true, saved = false;
  const service = createBotAccessPolicyService({ enabled: () => enabled, changed: id => events.push(id), authority: {
    read: workspaceId => ({ ok: true, policy: { workspaceId } }),
    resolve: () => null,
    update: input => { writes.push(input); return saved ? { ok: true, policy: { workspaceId: input.workspaceId } } : { ok: false, code: 'POLICY_UNAVAILABLE' }; },
  } });
  assert.equal(service.read({ workspaceId: 'a', conversationId: 'spoof' }).code, 'INVALID_INPUT');
  assert.equal(service.read({ conversationId: 'ordinary' }).policy, null);
  const input = { workspaceId: 'a', accessLevel: 'full_local', expectedRevision: 1 };
  assert.equal(service.update(input).ok, false); assert.equal(events.length, 0);
  saved = true; assert.equal(service.update(input).ok, true); assert.deepEqual(events, ['a']);
  enabled = false; assert.equal(service.update(input).code, 'PROJECT_AGENT_DISABLED'); assert.equal(writes.length, 2);
});

test('Bot access mutation remains restricted to the local main window and is absent from Quick Chat', () => {
  const entry = getDesktopIpcPolicy('project-agent:update-access-policy');
  assert.ok(entry);
  assert.equal(JSON.stringify(entry).includes('quick-chat'), false);
});

test('recovery approval cannot reuse a previous Bot policy revision, while plan approval stays separate', async () => {
  let current = { approvalId: 'old-tool', workspaceId: 'a', conversationId: 'child', planId: 'p', state: 'stale',
    capabilityId: 'local.file.write', policyRevision: 'bot:a:bot-a:1', argsDigest: 'a'.repeat(64) };
  let remembered = 0, resumed = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    accessAuthority: { resolve: () => ({ ok: true, policy: { workspaceId: 'a', conversationId: 'bot-a', revision: 2 } }) },
    approvals: { list: () => [current], append: record => { current = record; return record; } },
    settleLive: () => false, rememberGrant: () => { remembered++; },
    sessions: { get: () => null, resumeFromApproval: () => { resumed++; return { ok: true }; } },
  });
  const expired = await service.decideApproval({ workspaceId: 'a', approvalId: 'old-tool', decision: 'approve' });
  assert.equal(expired.approval.state, 'expired'); assert.equal(expired.approval.decisionReason, 'permission_policy_changed');
  assert.equal(remembered, 0); assert.equal(resumed, 0);
  current = { ...current, approvalId: 'plan:p', state: 'open', capabilityId: 'goal.plan' };
  const plan = await service.decideApproval({ workspaceId: 'a', approvalId: 'plan:p', decision: 'approve' });
  assert.equal(plan.approval.state, 'approved'); assert.equal(resumed, 1);
  service.dispose();
});

test('a committed Bot change retires stale tool cards without retiring a plan or an independent conversation', () => {
  const policy = { workspaceId: 'a', conversationId: 'bot-a', revision: 2 };
  const records = [
    { approvalId: 'tool', capabilityId: 'local.file.write', conversationId: 'child', state: 'stale' },
    { approvalId: 'plan:p', capabilityId: 'goal.plan', conversationId: 'child', state: 'open' },
    { approvalId: 'ordinary', capabilityId: 'local.file.write', conversationId: 'ordinary', state: 'open' },
  ];
  const retired = [];
  const service = createBotAccessPolicyService({ enabled: () => true, changed() {},
    authority: { update: () => ({ ok: true, policy }), resolve: input => input.conversationId === 'ordinary' ? null : { ok: true, policy } },
    approvals: { list: () => records, append: record => retired.push(record) },
  });
  assert.equal(service.update({ workspaceId: 'a', expectedRevision: 1, accessLevel: 'full_local' }).ok, true);
  assert.equal(retired.length, 1); assert.equal(retired[0].approvalId, 'tool'); assert.equal(retired[0].decisionReason, 'permission_policy_changed');
});
