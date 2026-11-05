import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationProvider } from './delegation-provider.mjs';
import { createDesktopReplyComposer } from './reply-composer-port.mjs';
import { composeReply } from './reply-composer.mjs';
import { createCoordinationLifecycle } from './coordination-lifecycle.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createEmptyResourceWaitPort } from './resource-wait.ts';

const user = (id = 'u1') => ({ id: `input-${id}`, inputId: id, role: 'user', kind: 'user_input', content: '去掉这个侧栏项',
  attachments: [{ id: 'screenshot', kind: 'image', mimeType: 'image/png', name: 'sidebar.png' }] });
const task = (anchor = 'u1') => ({ anchorMessageIds: [anchor], title: '去掉侧栏项', brief: '只调整临时夹具的导航项',
  successCriteria: [{ kind: 'model_review', description: '导航项移除，其他内容保留' }], kind: 'docs', readOnly: false, requiredCapabilities: [] });
function context(messages = [user()], extra = {}) {
  return { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', conversationId: 'parent', turnId: 'turn',
    currentInputAnchors: ['input-u1'], messages, toolCallOrdinal: 1, ...extra };
}
const call = (name, args, id = 'call-identity') => ({ call: { toolCallId: id, capabilityId: `local.delegation.${name}`, arguments: args } });
async function world(t, messages = [user()]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-user-anchor-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'goal', parentConversationId: 'parent', state: 'runnable' });
  const release = registerWorkBudget('w', store); const spawns = [];
  t.after(() => { release(); rmSync(root, { recursive: true, force: true }); });
  const lifecycle = createCoordinationLifecycle({ resourceWaits: createEmptyResourceWaitPort(), readMessages: () => messages, holdsLease: () => true,
    spawn: async (input, ctx) => {
      const sessionId = `session-${spawns.length}`;
      spawns.push(structuredClone(input));
      store.bindSession('goal', ctx.coordinationBinding.goalRevision, sessionId, { ...ctx.coordinationBinding, sessionId });
      return { sessionId, status: 'queued' };
    } });
  return { store, lifecycle, spawns, ctx: { ...context(messages), workId: 'goal' } };
}

test('A1/A2 coordination resolves the real input record before membership without changing source input IDs', async t => {
  const f = await world(t); const input = { action: 'parallel', reason: '用户要求', task: task() }; const original = structuredClone(input);
  const result = await f.lifecycle.coordinate(input, { ...f.ctx, deliveryKey: 'operation' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.spawns[0].anchorMessageIds, ['input-u1']);
  assert.deepEqual(f.store.read().mandates.goal.rootInputIds, ['u1']);
  assert.deepEqual(result.anchorResolutions, [{ field: 'task.anchorMessageIds', suppliedId: 'u1', messageId: 'input-u1', source: 'input_id' }]);
  assert.deepEqual(input, original);
  assert.equal((await f.lifecycle.coordinate({ ...input, task: task('input-u1') }, { ...f.ctx, deliveryKey: 'operation' })).replayed, true);
  assert.equal(f.spawns.length, 1);
});

test('A2 provider preserves the original call and Evidence identity while resolving spawn and real post_reply', async () => {
  const spawns = [];
  const provider = createDelegationProvider({ supervisor: { spawn: input => { spawns.push(input); return { sessionId: 's', status: 'queued' }; } },
    replyComposer: createDesktopReplyComposer() });
  const request = call('spawn_session', task()); const original = structuredClone(request);
  const receipt = await provider.executeCapability(request, context());
  assert.equal(receipt.result.status, 'success', JSON.stringify(receipt.result.output));
  assert.deepEqual(spawns[0].anchorMessageIds, ['input-u1']);
  assert.deepEqual(receipt.call, original.call); assert.deepEqual(request, original);
  assert.equal(receipt.result.evidence.evidenceId, 'delegation-call-identity');
  assert.equal(receipt.result.evidence.toolCallId, 'call-identity');
  const reply = await provider.executeCapability(call('post_reply', { replyTo: ['u1'], text: '已安排' }, 'reply-call'), { ...context(), toolCallOrdinal: 2 });
  assert.equal(reply.result.status, 'success'); assert.deepEqual(reply.result.output.message.replyTo, ['input-u1']);
  assert.deepEqual(reply.result.output.anchorResolutions, [{ field: 'replyTo', suppliedId: 'u1', messageId: 'input-u1', source: 'input_id' }]);
  assert.deepEqual(reply.result.outputPreview.control, { terminal: true, reason: 'project_agent_reply' });
});

test('A2 exact IDs win over aliases and canonical non-prefix IDs come from records, never string synthesis', () => {
  const users = [{ ...user(), id: 'unusual-message' }, { ...user('other'), id: 'u1' }];
  const raw = composeReply({ messageId: 'reply', kind: 'user', text: '收到', replyTo: ['u1'], userMessages: users });
  assert.equal(raw.ok, true); assert.deepEqual(raw.message.replyTo, ['u1']);
  const alias = composeReply({ messageId: 'reply', kind: 'user', text: '收到', replyTo: ['other'], userMessages: users });
  assert.equal(alias.ok, true); assert.deepEqual(alias.message.replyTo, ['u1']);
  const nonPrefix = composeReply({ messageId: 'reply', kind: 'user', text: '收到', replyTo: ['u1'], userMessages: [users[0]], evidenceRefs: ['agent-delivery:untouched'] });
  assert.equal(nonPrefix.ok, true); assert.deepEqual(nonPrefix.message.replyTo, ['unusual-message']);
  assert.deepEqual(nonPrefix.meta.evidenceRefs, ['agent-delivery:untouched']);
});

test('A3 aliases require exactly one canonical record; explicit legacy replies keep their existing predicate', () => {
  const compose = (ids, users) => composeReply({ messageId: 'reply', kind: 'user', text: '收到', replyTo: ids, userMessages: users });
  const duplicate = [user(), { ...user(), id: 'second-message' }];
  assert.equal(compose(['u1'], duplicate).error, 'anchor_ambiguous');
  assert.equal(compose(['input-u1'], [user(), user()]).error, 'anchor_ambiguous');
  assert.equal(compose(['u1'], [{ ...user(), role: 'assistant' }]).error, 'anchor_not_found');
  assert.equal(compose(['input-u1'], [{ ...user(), role: 'assistant' }]).ok, true, 'explicit legacy reply semantics stay unchanged');
  assert.equal(compose(['other-project'], [user()]).error, 'anchor_not_found');
});

test('A4 valid identity cannot enter a coordination scope through reply history; diagnostics are bounded', async t => {
  const users = [user(), ...Array.from({ length: 8 }, (_, i) => ({ ...user(`old-${i}`), content: '长'.repeat(200) }))];
  const f = await world(t, users);
  const denied = await f.lifecycle.coordinate({ action: 'parallel', reason: '不能借历史授权', task: task('old-7') }, { ...f.ctx, deliveryKey: 'denied' });
  assert.equal(denied.error, 'anchor_out_of_scope'); assert.equal(f.spawns.length, 0);
  assert.deepEqual(denied.availableAnchors, [{ messageId: 'input-u1', text: '去掉这个侧栏项' }]);
  const provider = createDelegationProvider({ replyComposer: createDesktopReplyComposer() });
  const result = await provider.executeCapability(call('post_reply', { replyTo: ['missing'], text: '收到' }), context(users));
  const candidates = result.result.output.availableReplyAnchors;
  assert.equal(candidates.length, 5); assert.ok(candidates.every(item => item.text.length === 120));
  assert.ok(candidates.every(item => Object.keys(item).sort().join() === 'messageId,text'));
});

test('A4 ordinary wake still rejects spawn after the same identity is resolved', async () => {
  let spawns = 0;
  const provider = createDelegationProvider({ supervisor: { spawn: () => { spawns++; return { sessionId: 's' }; } } });
  const result = await provider.executeCapability(call('spawn_session', task()), context([user()], { currentInputAnchors: [] }));
  assert.equal(result.result.output.error, 'current_user_required'); assert.equal(spawns, 0);
});

test('A3 explicit legacy reply compatibility never supplies canonical dispatch authority', async () => {
  let spawned = 0;
  const provider = createDelegationProvider({ supervisor: { spawn: () => { spawned++; return { sessionId: 's' }; } } });
  const result = await provider.executeCapability(call('spawn_session', task('input-u1')), context([{ ...user(), role: 'assistant' }]));
  assert.equal(result.result.output.error, 'anchor_not_user_input'); assert.equal(spawned, 0);
});
