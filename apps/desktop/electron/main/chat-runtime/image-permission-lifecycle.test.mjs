import { createTurnActivity } from '../../../../../packages/runtime-node/src/project-agent/turn-activity.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import { createApprovalStore, createLocalImageProvider } from '@peer-agent/runtime-node';
import { createChatPermissionGate } from './permission-gate.mjs';
import { createProjectAgentApplicationService } from '../project-agent/project-agent-application-service.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t, { fail = null, transportFailure = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-wait-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo);
  const image = join(root, 'actual.png'); await writeFile(image, PNG);
  let time = Date.now(), decoded = 0;
  const callbacks = new Map(), changes = [], events = [], controller = new AbortController();
  const store = createApprovalStore({ rootDir: join(root, 'approvals'), onChanged: change => changes.push(change.state) });
  const approvals = { list: store.list, append: row => fail?.(row) ? null : store.append(row) };
  const streams = new Map([['turn', { turnProfile: { role: 'project_agent', workspaceId: 'ws' }, runtimeTurn: { signal: controller.signal } }]]);
  const activity = createTurnActivity({ workspaceId: 'ws', conversationId: 'bot' });
  activity.begin({ turnId: 'turn', visible: true }); t.after(() => activity.dispose());
  const gate = createChatPermissionGate({ activeStreams: streams, approvalStore: approvals, now: () => time, permissionWaitMs: 100,
    permissionTimers: { schedule: callback => { const id = {}; callbacks.set(id, callback); return id; }, unschedule: id => callbacks.delete(id) },
    resolveApprovalScope: () => ({ workspaceId: 'ws' }) });
  const provider = createLocalImageProvider({ workspaceRoot: repo, decodeImage: () => { decoded++; return { width: 1, height: 1 }; } });
  const read = id => {
    activity.accept('chat:stream:tool-call', { streamId: 'turn', tool: 'view_image', toolCallId: id });
    return provider.executeCapability({ call: { toolCallId: id, capabilityId: 'local.image.read', arguments: { path: image } } }, {
      signal: controller.signal, toolContext: { turnRole: 'project_agent' },
      requestPermission: gate.createLocalCapabilityPermissionRequester({ streamId: 'turn', conversationId: 'bot', toolCallId: id, workspacePath: repo,
        webContents: { send: (channel, payload) => {
          if (transportFailure && channel === 'chat:stream:permission-request') throw new Error('sink unavailable');
          events.push({ channel, payload }); activity.accept(channel, payload);
        } } }),
    });
  };
  const wait = async (count = 1) => { for (let i = 0; i < 100 && gate.listPendingPermissions().length < count; i++) await new Promise(r => setTimeout(r, 2));
    assert.equal(gate.listPendingPermissions().length, count); assert.equal(decoded, 0); };
  const service = createProjectAgentApplicationService({ enabled: () => true, approvals,
    now: () => new Date(time).toISOString(), directory: { list: () => [] } });
  const decide = (decision, duration = 'once', id = 'read') => service.decideApproval({ workspaceId: 'ws', approvalId: `chat-permission:${id}`, decision, duration });
  return { read, wait, decide, gate, activity, store, callbacks, changes, events, controller,
    decoded: () => decoded, advance: ms => { time += ms; }, fire: () => { for (const callback of [...callbacks.values()]) callback(); } };
}

for (const duration of ['once', 'task']) test(`actual image resumes after ${duration} approval exactly once`, async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait();
  assert.equal(f.activity.snapshot().phase, 'awaiting_permission');
  assert.equal(f.activity.snapshot().segments[0].status, 'awaiting_permission');
  assert.deepEqual(f.changes, ['open']);
  assert.equal((await f.decide('approve', duration)).approval.state, 'approved');
  const result = await reading;
  assert.equal(result.result.status, 'success'); assert.equal(f.decoded(), 1);
  assert.equal(result.result.modelContext.visualObservations[0].dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal((await f.decide('approve', duration)).approval.state, 'approved');
  assert.equal(f.decoded(), 1); assert.equal(f.callbacks.size, 0); assert.equal(f.gate.listPendingPermissions().length, 0);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  assert.equal(f.activity.snapshot().phase, 'tool');
  assert.equal(f.store.list().filter(row => row.imageReadGrant).length, duration === 'task' ? 1 : 0);
  assert.equal(f.store.list().find(row => row.approvalId === 'chat-permission:read').deadlineAt != null, true);
});

for (const [decision, state, status, reason] of [['reject', 'denied', 'denied', 'image_permission_denied'],
  ['cancel', 'cancelled', 'cancelled', 'permission_cancelled']]) test(`actual image ${decision} closes without decoding`, async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait();
  assert.equal((await f.decide(decision)).approval.state, state);
  const result = await reading;
  assert.equal(result.result.status, status); assert.equal(result.result.outputPreview.reason, reason);
  assert.equal(result.result.modelContext, undefined); assert.equal(f.decoded(), 0);
  assert.equal(f.callbacks.size, 0); assert.equal((await f.decide('approve', 'task')).approval.state, state);
  assert.equal(f.store.list().some(row => row.imageReadGrant), false);
});

test('deadline beats late allow, leaves timeout Evidence and clears wait listeners', async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait(); f.advance(101); f.fire();
  const result = await reading;
  assert.equal(result.result.status, 'timeout'); assert.equal(result.result.outputPreview.reason, 'permission_timeout');
  assert.equal(result.result.modelContext, undefined); assert.ok(result.result.evidence);
  assert.equal((await f.decide('approve', 'task')).approval.state, 'expired');
  assert.equal(f.decoded(), 0); assert.equal(f.callbacks.size, 0); assert.equal(f.gate.listPendingPermissions().length, 0);
  assert.deepEqual(f.changes, ['open', 'expired']);
});

test('abort cancels every pending image in the turn and late permission never revives it', async t => {
  const f = await fixture(t); const reads = [f.read('one'), f.read('two')]; await f.wait(2); f.controller.abort();
  for (const result of await Promise.all(reads)) { assert.equal(result.result.status, 'cancelled'); assert.equal(result.result.modelContext, undefined); }
  assert.equal(f.callbacks.size, 0); assert.equal(f.gate.listPendingPermissions().length, 0);
  assert.equal((await f.decide('approve', 'task', 'one')).approval.state, 'cancelled');
  assert.equal(f.store.list().some(row => row.imageReadGrant), false);
});

test('one permission settles while another stays visible and waiting', async t => {
  const f = await fixture(t); const one = f.read('one'), two = f.read('two'); await f.wait(2);
  await f.decide('reject', 'once', 'one'); await one;
  assert.equal(f.activity.snapshot().phase, 'awaiting_permission'); assert.equal(f.gate.listPendingPermissions().length, 1);
  await f.decide('approve', 'once', 'two'); assert.equal((await two).result.status, 'success');
  assert.equal(f.decoded(), 1); assert.equal(f.activity.snapshot().phase, 'tool');
});

test('deadline is checked on claim even before its timer gets CPU time', async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait(); f.advance(101);
  assert.equal(f.gate.settlePermissionRequest('chat-permission:read', { granted: true, duration: 'task' }), false);
  assert.equal((await reading).result.status, 'timeout'); assert.equal(f.decoded(), 0); assert.equal(f.callbacks.size, 0);
});

test('late card decision releases the original image wait even before the timer fires', async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait(); f.advance(101);
  assert.equal((await f.decide('approve', 'task')).approval.state, 'expired');
  assert.equal((await reading).result.status, 'timeout'); assert.equal(f.decoded(), 0);
  assert.equal(f.callbacks.size, 0); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('failed permission presentation ends promptly with Evidence and no dangling wait', async t => {
  const f = await fixture(t, { transportFailure: true }); const result = await f.read('read');
  assert.equal(result.result.outputPreview.reason, 'permission_unavailable'); assert.ok(result.result.evidence);
  assert.equal(f.store.list()[0].state, 'expired'); assert.equal(f.decoded(), 0);
  assert.equal(f.callbacks.size, 0); assert.equal(f.gate.listPendingPermissions().length, 0);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('failure to persist approved fact fails closed instead of returning image pixels', async t => {
  const f = await fixture(t, { fail: row => row.state === 'approved' }); const reading = f.read('read'); await f.wait();
  await f.decide('approve'); const result = await reading;
  assert.equal(result.grant.granted, false); assert.equal(result.result.modelContext, undefined);
  assert.equal(result.result.outputPreview.reason, 'permission_unavailable'); assert.equal(f.decoded(), 0);
});

test('restart expires timed-out pending requests instead of presenting recoverable permissions', async t => {
  const f = await fixture(t); const reading = f.read('read'); await f.wait();
  const store = createApprovalStore({ rootDir: join(f.store.fileFor('ws'), '..', '..'), now: () => new Date(Date.now() + 1000) });
  assert.equal(store.markStaleOnStartup()[0].state, 'expired');
  assert.equal((await f.decide('approve', 'task')).approval.state, 'expired');
  f.controller.abort(); await reading;
});
