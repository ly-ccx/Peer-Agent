import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApprovalStore, createLocalImageProvider, resolvePermissionPrincipal } from '@peer-agent/runtime-node';
import { createChatPermissionGate } from './permission-gate.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('exact image approval reaches Bot, worker, verifier and restarted host; all invalid inheritances fail', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-authority-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const image = join(root, 'screen.png'); await writeFile(image, PNG);
  const store = createApprovalStore({ rootDir: join(root, 'approvals'), compactBytes: 1 });
  let now = Date.now();
  const plan = { conversationId: 'child', status: 'completed', delegationOrigin: {
    workspaceId: 'w', sessionId: 'worker', parentConversationId: 'bot', phase: 'waiting_decision' } };
  const plans = { getPlan: id => id === 'plan' ? plan : null };
  const streams = new Map([
    ['bot', { turnProfile: { role: 'project_agent', workspaceId: 'w' } }],
    ['worker', { approver: 'none', turnProfile: { role: 'work_session', workspaceId: 'w', sessionId: 'worker', planId: 'plan' } }],
    ['verify', { approver: 'none', turnProfile: { role: 'work_session', agentKind: 'verifier', workspaceId: 'w', sessionId: 'worker', planId: 'plan' } }],
  ]);
  const gateFactory = () => createChatPermissionGate({ activeStreams: streams, approvalStore: store, now: () => now,
    resolvePermissionPrincipal: ({ streamId, conversationId }) => resolvePermissionPrincipal({
      ...streams.get(streamId)?.turnProfile, conversationId, goalPlanStore: plans }) });
  let gate = gateFactory();
  const provider = createLocalImageProvider({ workspaceRoot: repo, decodeImage: () => ({ width: 1, height: 1 }) });
  const read = (streamId, conversationId, id, path = image, webContents = { approver: 'none' }) => provider.executeCapability({
    call: { toolCallId: id, capabilityId: 'local.image.read', arguments: { path } } }, {
    toolContext: { accessLevel: 'restricted_local', turnRole: streamId === 'bot' ? 'project_agent' : 'work_session' },
    requestPermission: gate.createLocalCapabilityPermissionRequester({ streamId, conversationId, toolCallId: id, workspacePath: repo, webContents }) });
  let approve;
  const asked = new Promise(resolve => { approve = resolve; });
  const first = read('bot', 'bot', 'initial', image, { send: (channel, { call }) => approve(call) });
  const call = await asked;
  assert.equal(call.capabilityId, 'local.image.read'); assert.equal(call.argumentsPreview.path, image);
  gate.settlePermissionRequest(call.toolCallId, { grantId: 'ui', toolCallId: call.toolCallId,
    granted: true, duration: 'scope', decidedAt: new Date(now).toISOString() });
  const initial = await first;
  assert.equal(initial.result.status, 'success');
  assert.match(initial.grant.grantId, /^image-/);
  assert.equal(store.list().filter(r => r.imageReadGrant).length, 1);
  for (const [stream, convo] of [['bot', 'bot'], ['worker', 'child'], ['verify', null]]) {
    const result = await read(stream, convo, stream);
    assert.equal(result.result.status, 'success');
    assert.equal(result.grant.grantId, initial.grant.grantId);
    assert.equal(result.result.modelContext.visualObservations[0].dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  }
  gate = gateFactory();
  assert.equal((await read('verify', null, 'restart')).result.status, 'success');
  const denied = async (...args) => {
    const result = await read(...args); assert.equal(result.result.status, 'denied');
    assert.equal(result.result.modelContext, undefined);
  };
  await denied('bot', 'another-bot', 'other-owner');
  streams.get('verify').turnProfile.workspaceId = 'other';
  await denied('verify', null, 'other-workspace'); streams.get('verify').turnProfile.workspaceId = 'w';
  streams.get('verify').turnProfile.sessionId = 'forged';
  await denied('verify', null, 'other-session'); streams.get('verify').turnProfile.sessionId = 'worker';
  plan.delegationOrigin.phase = 'cancelled'; await denied('verify', null, 'cancelled'); plan.delegationOrigin.phase = 'waiting_decision';
  const other = join(root, 'other.png'); await writeFile(other, PNG); await denied('verify', null, 'other-file', other);
  now += 30 * 60 * 1000; await denied('verify', null, 'expired'); now -= 30 * 60 * 1000;
  await writeFile(image, PNG); await denied('verify', null, 'changed-file');
  gate.setAccessLevel('restricted_local');
  assert.equal(store.list().some(r => r.imageReadGrant && r.state === 'approved'), false);
  gate = gateFactory(); await denied('verify', null, 'revoked-after-restart');
});

test('policy withdrawal removes durable image authority and approval storage failure cannot grant a scope', async () => {
  const events = [];
  const scope = { capabilityId: 'local.image.read', path: '/outside/a.png', workspacePath: '/repo',
    action: 'read_image_for_model', fileIdentity: { dev: 1, ino: 1, size: 2, mtimeMs: 3, ctimeMs: 4 } };
  const failing = { append: () => { throw new Error('disk unavailable'); }, list: () => [] };
  const gate = createChatPermissionGate({ activeStreams: new Map([['s', {}]]), approvalStore: failing });
  const result = gate.createLocalCapabilityPermissionRequester({ streamId: 's', toolCallId: 'i', conversationId: 'bot', workspacePath: '/repo',
    webContents: { send: (channel, { call }) => events.push(call) } })({ capabilityId: 'local.image.read', args: { path: scope.path }, scope });
  assert.equal(events.length, 0);
  assert.equal((await result).reason, 'permission_unavailable');
  assert.equal(gate.listPendingPermissions().length, 0);
});
