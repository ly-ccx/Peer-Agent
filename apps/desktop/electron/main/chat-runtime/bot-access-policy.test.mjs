import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotAccessPolicyAuthority, createLocalImageProvider, createApprovalStore } from '@peer-agent/runtime-node';
import { createChatPermissionGate } from './permission-gate.mjs';

function fixture(t) {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), 'peer-gate-bot-'));
  const profiles = new Map(['a', 'b'].map(id => [id, { workspaceId: id, agentConversationId: `bot-${id}`, status: 'active' }]));
  for (const id of profiles.keys()) mkdirSync(path.join(dataHome, 'projects', id), { recursive: true });
  const plans = new Map([['p', { planId: 'p', conversationId: 'child', status: 'running', delegationOrigin: { workspaceId: 'a', sessionId: 's', parentConversationId: 'bot-a' } }]]);
  const options = { dataHome, profileStore: { read: id => profiles.get(id) }, goalPlanStore: {
    getPlan: id => plans.get(id), getActivePlanByConversation: id => [...plans.values()].find(row => row.conversationId === id),
  }, legacyAccessLevel: 'full_local' };
  const authority = createBotAccessPolicyAuthority(options), other = createBotAccessPolicyAuthority(options);
  authority.initialize();
  authority.update({ workspaceId: 'b', expectedRevision: 1, accessLevel: 'ask_before_local' });
  const events = [], store = createApprovalStore({ rootDir: path.join(dataHome, 'project-runtime') });
  const gate = createChatPermissionGate({ activeStreams: new Map(), accessLevel: 'full_local', approvalStore: store,
    resolveAccessPolicy: ({ conversationId }) => authority.resolve({ conversationId, workspaceId: conversationId === 'bot-b' ? 'b' : conversationId === 'ordinary' ? undefined : 'a' }),
    resolvePermissionPrincipal: ({ conversationId }) => { const result = authority.resolve({ conversationId, workspaceId: conversationId === 'bot-b' ? 'b' : 'a' });
      return result?.ok ? { workspaceId: result.policy.workspaceId, conversationId: result.policy.conversationId } : null; },
  });
  const sink = { approver: 'none', send: (...args) => events.push(args) };
  const requester = (conversationId, id = conversationId, webContents = sink) => gate.createLocalCapabilityPermissionRequester({
    streamId: id, toolCallId: id, conversationId, workspacePath: dataHome, webContents,
  });
  t.after(() => { gate.refreshAccessPolicies(); authority.close(); other.close(); rmSync(dataHome, { recursive: true, force: true }); });
  return { dataHome, authority, other, gate, plans, store, events, sink, requester,
    change: (id, accessLevel) => { const current = other.read(id).policy; return other.update({ workspaceId: id, expectedRevision: current.revision, accessLevel }); } };
}

test('two Bot policies are isolated from each other and the classic global setting; Worker follows parent dynamically', async t => {
  const f = fixture(t);
  const ask = id => f.requester(id)({ capabilityId: 'local.test', args: { value: 1 } });
  const original = await ask('child'); assert.equal(original.granted, true);
  assert.equal((await ask('bot-b')).granted, false);
  f.gate.setAccessLevel('restricted_local');
  assert.equal(original.validate(), true);
  assert.equal((await ask('bot-a')).granted, true);
  f.change('a', 'ask_before_local');
  assert.equal(original.validate(), false);
  assert.equal((await ask('child')).granted, false);
  f.change('a', 'full_local');
  assert.equal(original.validate(), false);
  assert.equal((await ask('child')).granted, true);
});

test('file and shell requesters use the same per-Bot authority', async t => {
  const f = fixture(t);
  for (const conversationId of ['bot-a', 'bot-b']) {
    const expected = conversationId === 'bot-a';
    const context = { streamId: conversationId, toolCallId: conversationId, conversationId, workspacePath: f.dataHome, webContents: f.sink };
    const file = await f.gate.createFilePermissionRequester(context)({ tool: 'write_file', args: { content: 'x' }, filePath: '/outside/a', workspacePath: f.dataHome });
    assert.equal(file.granted, expected);
    const shell = await f.gate.createShellApprovalDecider(context)({ call: {}, classification: { command: 'write a', cwd: f.dataHome, riskLevel: 'L2_local_write', category: 'write' }, ruleDecision: {} });
    assert.equal(shell.granted, expected);
  }
});

test('a policy change closes only its own pending request; late decisions cannot grant or resurrect it', async t => {
  const f = fixture(t); f.change('a', 'ask_before_local');
  const sink = { send() {} };
  const first = f.requester('bot-a', 'a', sink)({ capabilityId: 'local.test', args: {} });
  const second = f.requester('bot-b', 'b', sink)({ capabilityId: 'local.test', args: {} });
  assert.equal(f.gate.listPendingPermissions().length, 2);
  f.change('a', 'full_local'); f.gate.refreshAccessPolicies();
  assert.equal((await first).granted, false);
  assert.equal(f.gate.listPendingPermissions().length, 1);
  assert.equal(f.gate.settlePermissionRequest('chat-permission:a', { granted: true }), false);
  f.gate.settlePermissionRequest('chat-permission:b', { granted: false }); await second;
  assert.equal(f.store.list().find(record => record.approvalId === 'chat-permission:a').decisionReason, 'permission_policy_changed');
});

test('a different host policy update is observed while a permission request is waiting', async t => {
  const f = fixture(t); f.change('a', 'ask_before_local');
  const pending = f.requester('bot-a', 'pending', { send() {} })({ capabilityId: 'local.test', args: {} });
  f.change('a', 'full_local');
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  assert.equal((await pending).granted, false);
  assert.equal(f.gate.listPendingPermissions().length, 0);
});

test('real image pixels and Evidence are returned under the parent policy and revoked during decode', async t => {
  const f = fixture(t);
  const workspace = path.join(f.dataHome, 'workspace'); mkdirSync(workspace);
  const image = path.join(f.dataHome, 'outside.png');
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  let revoke = false;
  const provider = createLocalImageProvider({ workspaceRoot: workspace, decodeImage: () => {
    if (revoke) f.change('a', 'ask_before_local'); return { width: 1, height: 1 };
  } });
  const read = id => provider.executeCapability({ call: { toolCallId: id, capabilityId: 'local.image.read', arguments: { path: image } } },
    { requestPermission: f.requester('child', id), toolContext: { readableRoots: [workspace] } });
  const allowed = await read('pixels');
  assert.equal(allowed.result.status, 'success'); assert.ok(allowed.result.evidence); assert.ok(allowed.result.modelContext.visualObservations.length);
  revoke = true;
  const denied = await read('revoked'); assert.equal(denied.grant.granted, false); assert.equal(denied.result.modelContext, undefined);
});

test('invalid delegated identities are denied without emitting a permission card or using global Full', async t => {
  const f = fixture(t); f.plans.get('p').status = 'paused';
  assert.equal((await f.requester('child')({ capabilityId: 'local.test', args: {} })).granted, false);
  assert.equal(f.gate.listPendingPermissions().length, 0); assert.equal(f.events.length, 0);
});
