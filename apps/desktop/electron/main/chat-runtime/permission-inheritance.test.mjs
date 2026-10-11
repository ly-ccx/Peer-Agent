import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPermissionGate } from './permission-gate.mjs';

function fixture() {
  const events = [];
  const gate = createChatPermissionGate({ activeStreams: new Map([['s', {}]]) });
  const webContents = { send: (channel, payload) => events.push({ channel, payload }) };
  const invoke = (id, capabilityId, args, conversationId = 'bot', workspacePath = '/repo') =>
    gate.createLocalCapabilityPermissionRequester({ webContents, streamId: 's', toolCallId: id, conversationId, workspacePath })({ capabilityId, args });
  const settle = (granted, duration = 'once') => {
    const call = gate.listPendingPermissions().at(-1)?.call;
    if (call) gate.settlePermissionRequest(call.toolCallId, { grantId: 'fixture', toolCallId: call.toolCallId,
      granted, duration, decidedAt: new Date().toISOString() });
  };
  return { gate, events, invoke, settle, webContents };
}

test('same source id cannot inherit a different capability, argument, conversation or workspace', async () => {
  for (const change of [
    ['local.other', { path: '/outside/a' }, 'bot', '/repo'],
    ['local.image.read', { path: '/outside/b' }, 'bot', '/repo'],
    ['local.image.read', { path: '/outside/a' }, 'other', '/repo'],
    ['local.image.read', { path: '/outside/a' }, 'bot', '/other'],
  ]) {
    const f = fixture();
    const first = f.invoke('source', 'local.image.read', { path: '/outside/a' });
    f.settle(true); await first;
    const second = f.invoke('source', ...change);
    assert.equal(f.gate.listPendingPermissions().length, 1);
    f.settle(false); assert.equal((await second).granted, false);
  }
});

test('allow once does not authorize another file write', async () => {
  const f = fixture();
  const invoke = (id, filePath) => f.gate.createFilePermissionRequester({ webContents: f.webContents,
    streamId: 's', toolCallId: id, conversationId: 'bot' })({ tool: 'write_file', args: { path: filePath, content: 'x' }, filePath, workspacePath: '/repo' });
  const first = invoke('a', '/outside/a'); f.settle(true); await first;
  const second = invoke('b', '/outside/b');
  assert.equal(f.gate.listPendingPermissions().length, 1);
  f.settle(false); assert.equal((await second).granted, false);
});

test('explicit scope grants only cover the exact operation and are revoked on policy change', async () => {
  const f = fixture();
  const first = f.invoke('a', 'local.file.write', { path: '/outside/a', content: 'x' });
  f.settle(true, 'scope'); await first;
  const different = f.invoke('b', 'local.file.write', { path: '/outside/b', content: 'x' });
  assert.equal(f.gate.listPendingPermissions().length, 1);
  f.settle(false); await different;
  f.gate.setAccessLevel('restricted_local');
  const after = f.invoke('c', 'local.file.write', { path: '/outside/a', content: 'x' });
  assert.equal(f.gate.listPendingPermissions().length, 1);
  f.settle(false); await after;
});
