import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalStore } from '@peer-agent/runtime-node';
import { RESOURCE_FILE_REPLACE_CAPABILITY as capabilityId } from '@peer-agent/protocol';
import { createResourceEditPermissionBridge } from './resource-edit-permission-bridge.mjs';
import { createChatPermissionGate, settleActivePermissionRequest } from './chat-runtime/permission-gate.mjs';
const digest = 'sha256:' + 'a'.repeat(64);
function fixture(t, accessLevel = 'ask_before_local') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-permissions-')), approvals = createApprovalStore({ rootDir: root });
  const sender = {}, handle = { viewId: 'view', windowId: 'window', generation: 1, draftId: 'draft' };
  const binding = { sender, handle }, notices = []; let revision = 1, current = true, time = Date.now();
  const operation = { requestId: 'request', draftId: 'draft', payloadHash: digest, proposedVersion: digest,
    target: { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/fixture/a.md' }, base: { contentVersion: digest } } };
  const bridge = createResourceEditPermissionBridge({ approvalStore: approvals, authority: { read: () => ({ ok: true, policy: { workspaceId: 'bot', conversationId: 'main', revision, accessLevel } }) },
    isCurrent: candidate => candidate === binding && current, now: () => time, notify: (...args) => notices.push(args) });
  t.after(() => { bridge.dispose(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(bridge.begin(operation, binding).ok, true);
  const request = (extra = {}, options = {}) => bridge.request(operation, binding, { capabilityId, toolName: 'replace_file_if_version', reason: 'Apply this exact saved draft.',
    args: { requestId: operation.requestId, bytes: 3, proposedVersion: digest }, scope: { kind: 'resource-edit', path: '/fixture/a.md' }, ...extra }, options);
  const decide = (allow, extra = {}) => { const challenge = bridge.pending(operation, binding); return bridge.decide(operation, binding, {
    handle, requestId: operation.requestId, challengeId: challenge?.challengeId, argsDigest: challenge?.argsDigest, allow, ...extra }); };
  return { bridge, operation, binding, handle, approvals, notices, request, decide, changePolicy: () => { revision++; }, expire: () => { current = false; },
    advance: () => { time += 1_000_000; } };
}
test('actual Bot full access yields a real capability-scoped grant; Hook confirmation still requires a separate decision', async t => {
  const f = fixture(t, 'full_local'); const allowed = await f.request(); assert.equal(allowed.granted, true); assert.equal(allowed.grant.scope, capabilityId); assert.equal(allowed.validate(), true);
  assert.equal(f.bridge.pending(f.operation, f.binding), null);
  const hook = f.request({ confirmation: { kind: 'hook-approval', reason: 'Explicit local Hook review.' } });
  assert.equal(f.bridge.pending(f.operation, f.binding).confirmation, 'Explicit local Hook review.'); assert.equal(f.decide(false).ok, true);
  assert.equal((await hook).granted, false);
});
test('pending challenge rejects foreign handles, stale digests and renderer grants, then issues only one actual decision', async t => {
  const f = fixture(t), pending = f.request(), challenge = f.bridge.pending(f.operation, f.binding);
  assert.ok(challenge); assert.match(challenge.argsDigest, /^sha256:/);
  assert.equal(f.decide(true, { handle: { ...f.handle, generation: 2 } }).ok, false);
  assert.equal(f.decide(true, { argsDigest: 'sha256:' + 'b'.repeat(64) }).ok, false);
  assert.equal(f.decide(true, { grant: { granted: true, duration: 'persistent' } }).ok, false);
  assert.equal(f.decide(true).ok, true); const decision = await pending;
  assert.equal(decision.granted, true); assert.equal(decision.grant.duration, 'once'); assert.equal(decision.grant.scope, capabilityId);
  assert.equal(decision.grant.toolCallId, 'chat-permission:resource-edit:request'); assert.equal(decision.validate(), true);
  assert.equal(f.bridge.pending(f.operation, f.binding), null); assert.equal(f.decide(true, { challengeId: challenge.challengeId, argsDigest: challenge.argsDigest }).ok, false);
  assert.equal(f.approvals.list({ workspaceId: 'bot' })[0].state, 'approved');
  f.changePolicy(); assert.equal(decision.validate(), false);
});
test('policy/source changes and expired or aborted challenges cannot authorize a later write', async t => {
  for (const action of ['policy', 'source', 'deadline', 'abort']) {
    const f = fixture(t), controller = new AbortController(), pending = f.request({}, { signal: controller.signal });
    const challenge = f.bridge.pending(f.operation, f.binding);
    if (action === 'policy') f.changePolicy(); if (action === 'source') f.expire(); if (action === 'deadline') f.advance(); if (action === 'abort') controller.abort();
    assert.equal(f.decide(true, { challengeId: challenge.challengeId, argsDigest: challenge.argsDigest }).ok, false);
    f.bridge.finish(f.operation); assert.equal((await pending).granted, false);
  }
});
test('a resource bridge never replaces the active chat permission gate', async t => {
  const activeStreams = new Map([['chat', {}]]), chat = createChatPermissionGate({ activeStreams, oneTimeApprovals: null }); let call;
  t.after(() => chat.settleStreamPermissionRequests('chat', { granted: false, duration: 'denied' }));
  const pending = chat.createLocalCapabilityPermissionRequester({ webContents: { send: (_topic, event) => { call = event.call; } }, streamId: 'chat', toolCallId: 'chat-call', conversationId: 'chat-conversation' })({ capabilityId: 'local.file.write', args: { path: '/fixture/chat.md' } });
  fixture(t);
  assert.equal(settleActivePermissionRequest(call.toolCallId, { granted: false, duration: 'denied' }), true);
  assert.equal((await pending).granted, false);
});
test('requesting extra Hook review cannot override an existing capability policy denial', async () => {
  let sent = 0;
  const gate = createChatPermissionGate({ registerActive: false, activeStreams: new Map([['operation', {}]]), accessLevel: 'full_local' });
  const result = await gate.createLocalCapabilityPermissionRequester({ streamId: 'operation', toolCallId: 'blocked', webContents: { send: () => { sent++; } },
    respectConfirmation: true, permissionPolicy: { kind: 'automation', blockedCapabilityIds: [capabilityId] } })({ capabilityId, confirmation: { kind: 'hook-approval' } });
  assert.equal(result.granted, false); assert.equal(sent, 0);
});
