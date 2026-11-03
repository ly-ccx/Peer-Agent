import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractiveAuthority, interactiveCapabilitiesForProfile, interactiveExecutionRole } from './authority.mjs';
import { executionIdentity } from '../project-agent/session-control-kernel.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' }, fixed = { owner, resultId: 'result-a', contentVersion: `sha256:${'a'.repeat(64)}` };
function fixture() {
  let leased = true, enabled = true, parent = 'parent-a';
  const plan = { planId: 'plan-a', conversationId: 'worker-a', createdAt: '2026-11-03T00:00:00Z', delegationOrigin: {
    workspaceId: 'bot-a', sessionId: 'session-a', parentConversationId: 'parent-a', phase: 'running', readOnly: true, executionGeneration: 'generation-a' } };
  const other = { ...structuredClone(plan), planId: 'plan-b', conversationId: 'worker-b', delegationOrigin: { ...structuredClone(plan.delegationOrigin), sessionId: 'session-b' } };
  const plans = new Map([[plan.planId, plan], [other.planId, other]]), messages = [];
  const fixedResult = { reference: fixed, source: { ...executionIdentity(plan), conversationId: plan.conversationId, toolCallId: 'publish-a' } };
  const service = createInteractiveAuthority({ goalPlanStore: { getPlan: id => plans.get(id) },
    conversationStore: { getPersistedConversationHistory: () => ({ messages }) },
    resultStore: { getVersion: () => fixedResult, getOperation: () => ({ reference: fixed }) },
    getBotConversationId: () => parent, holdsLease: () => leased, enabled: () => enabled, classifyContext: () => 'D3_private' });
  const profile = { role: 'work_session', agentKind: 'worker', planId: plan.planId, sessionId: plan.delegationOrigin.sessionId,
    workspaceId: owner.workspaceId, executionIdentity: executionIdentity(plan) };
  const context = { conversationId: plan.conversationId, workspaceId: owner.workspaceId, turnProfile: profile };
  const resolve = (patch = {}) => service.resolve({ call: { toolCallId: 'publish-a', capabilityId: PUBLISH }, toolContext: { ...context, ...patch } });
  return { plan, other, plans, messages, fixedResult, profile, context, resolve, setLeased: value => { leased = value; },
    setEnabled: value => { enabled = value; }, setParent: value => { parent = value; } };
}
test('role inventory maps actual work_session profiles and only admitted workers receive publish', () => {
  assert.deepEqual(interactiveCapabilitiesForProfile({ role: 'work_session', agentKind: 'worker' }), [PUBLISH, INSPECT]);
  for (const kind of ['verifier', 'visual_verifier']) assert.deepEqual(interactiveCapabilitiesForProfile({ role: 'work_session', agentKind: kind }), [INSPECT]);
  for (const profile of [{ role: 'work_session', agentKind: 'explorer' }, { role: 'session_worker' }, {}, { role: 'chat' }]) assert.deepEqual(interactiveCapabilitiesForProfile(profile), []);
  assert.equal(interactiveExecutionRole({ role: 'work_session', agentKind: 'worker' }), 'session_worker');
});
test('authority binds canonical plan, owner, current generation and actual host lease, not model arguments', () => {
  const f = fixture(), authority = f.resolve();
  assert.deepEqual(authority.owner, owner); assert.equal(authority.source.toolCallId, 'publish-a');
  assert.equal(authority.assertCurrent(), true); assert.equal(authority.dataLevel, 'D3_private');
  f.setLeased(false); assert.equal(authority.assertCurrent(), false);
  assert.throws(() => f.resolve(), { code: 'interactive_execution_stale' });
  f.setLeased(true); f.plan.delegationOrigin.executionGeneration = 'new-generation';
  assert.equal(authority.assertCurrent(), false); assert.throws(() => f.resolve(), { code: 'interactive_execution_stale' });
});
test('owner changes, wrong child/parent, role forgery, paused work and feature withdrawal fail closed', () => {
  const f = fixture();
  for (const patch of [ { conversationId: 'parent-a' }, { workspaceId: 'other' },
    { turnProfile: { ...f.profile, sessionId: 'other-session' } }, { turnProfile: { ...f.profile, workspaceId: 'other' } } ]) {
    assert.throws(() => f.resolve(patch));
  }
  f.setParent('new-parent'); assert.throws(() => f.resolve(), { code: 'interactive_execution_stale' }); f.setParent('parent-a');
  f.plan.delegationOrigin.phase = 'paused'; assert.throws(() => f.resolve(), { code: 'interactive_execution_stale' });
  f.plan.delegationOrigin.phase = 'running'; f.setEnabled(false); assert.throws(() => f.resolve(), { code: 'interactive_execution_stale' });
});
test('actual same-work fixed results are admitted; another work requires canonical user feedback and cannot borrow assistant prose', () => {
  const f = fixture(), authority = f.resolve();
  assert.equal(authority.admitResult(fixed), true);
  f.fixedResult.source = { ...executionIdentity(f.other), conversationId: 'worker-b', toolCallId: 'other-publish' };
  assert.equal(authority.admitResult(fixed), false);
  const feedback = { recipient: owner, resource: { kind: 'interactive', reference: fixed }, version: { kind: 'interactive', followupId: 'followup-a' } };
  f.messages.push({ role: 'assistant', content: JSON.stringify(fixed), resourceFeedback: [feedback] });
  assert.equal(authority.admitResult(fixed), false); assert.equal(authority.admitFollowup('followup-a'), false);
  f.messages.push({ role: 'user', resourceFeedback: [feedback] });
  assert.equal(authority.admitResult(fixed), true); assert.equal(authority.admitFollowup('followup-a'), true);
  assert.equal(authority.admitFollowup('guessed-id'), false);
  assert.equal(authority.admitResult({ ...fixed, owner: { ...owner, workspaceId: 'foreign' } }), false);
});
test('source material admission is exact to the current child and canonical user uploads', () => {
  const f = fixture(), authority = f.resolve();
  assert.equal(authority.admitMaterial({ kind: 'tool-result', conversationId: 'worker-a' }), true);
  assert.equal(authority.admitMaterial({ kind: 'tool-result', conversationId: 'worker-b' }), false);
  assert.equal(authority.admitMaterial({ kind: 'user-material', messageId: 'm', attachmentId: 'a' }), false);
  f.messages.push({ id: 'm', role: 'user', attachments: [{ id: 'a', sourceKind: 'user_upload' }] });
  assert.equal(authority.admitMaterial({ kind: 'user-material', messageId: 'm', attachmentId: 'a' }), true);
  assert.equal(authority.admitMaterial({ kind: 'user-material', messageId: 'other-m', attachmentId: 'a' }), false);
});
test('main Bot authority is read only and bound to the registered canonical parent', () => {
  const f = fixture();
  const authority = f.resolve({ conversationId: 'parent-a', turnProfile: { role: 'project_agent', workspaceId: 'bot-a' } });
  assert.deepEqual(authority.capabilityIds, [INSPECT]); assert.equal(authority.source, undefined); assert.equal(authority.admitResult(fixed), true);
  assert.throws(() => f.resolve({ conversationId: 'forged-parent', turnProfile: { role: 'project_agent', workspaceId: 'bot-a' } }), { code: 'interactive_execution_stale' });
});

test('dynamic Bot policy revision is pinned for grant audit and rechecked after every asynchronous step', () => {
  const f = fixture();
  let revision = 2;
  const resolveAccessPolicy = () => ({ ok: true, policy: { workspaceId: owner.workspaceId, conversationId: owner.conversationId, revision } });
  const authority = f.resolve({ resolveAccessPolicy });
  assert.equal(authority.policyRevision, 'bot:bot-a:parent-a:2'); assert.equal(authority.assertCurrent(), true);
  revision = 3; assert.equal(authority.assertCurrent(), false);
  assert.throws(() => f.resolve({ resolveAccessPolicy: () => ({ ok: true, policy: { workspaceId: 'foreign', conversationId: 'parent-a', revision: 3 } }) }), { code: 'interactive_policy_unavailable' });
});
