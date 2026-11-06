import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RESOURCE_FILE_REPLACE_PROVIDER, RESOURCE_FILE_REPLACE_CAPABILITY, normalizeResourceEditTarget } from '@peer-agent/protocol';
import { createResourceEditRuntime } from './resource-edit-runtime.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture(t, hook = 'allow', failure = null) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-resource-runtime-'))), file = path.join(root, 'a.md');
  t.after(() => rmSync(root, { recursive: true, force: true })); writeFileSync(file, 'old');
  const content = 'new', target = normalizeResourceEditTarget({ recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: { workspaceId: 'bot', path: file }, base: { resourceId: hash('id'), contentVersion: hash('old') } });
  const operation = { requestId: 'request', draftId: 'draft', draftRevision: 1, target, providerId: RESOURCE_FILE_REPLACE_PROVIDER, proposedVersion: hash(content), payloadHash: hash('payload'), phase: 'running', hostEpoch: 'epoch', createdAt: '2026-10-27T02:00:00Z', updatedAt: '2026-10-27T02:00:00Z' };
  operation.payloadHash = hash(JSON.stringify({ draftId: operation.draftId, draftRevision: operation.draftRevision, target, providerId: operation.providerId, proposedVersion: operation.proposedVersion }));
  const events = [], order = [], requests = [], records = [], postludes = [];
  const runtime = createResourceEditRuntime({ sessionStore: { getSession: () => ({ locale: 'en-US', accessLevel: 'ask_before_local' }) },
    resolveTarget: async () => { order.push('resolve'); return { ok: true, root, path: file, resourceId: target.base.resourceId, validate: () => true }; },
    isIntentCurrent: () => true,
    requestPermission: async (actual, request) => { requests.push({ operation: actual, request }); order.push('permission');
      if (failure === 'permission-timeout') return { granted: false, reason: 'permission_timeout', grant: { grantId: 'real-timeout', toolCallId: `chat-permission:${request.toolCallId}`, granted: false, duration: 'denied', decidedAt: '2026-10-27T02:00:00Z' } };
      return { granted: true, grant: { grantId: 'real-grant', toolCallId: request.toolCallId, granted: true, duration: 'once', scope: RESOURCE_FILE_REPLACE_CAPABILITY, decidedAt: '2026-10-27T02:00:00Z' }, validate: () => true }; },
    hookRunner: { runPreToolUse: async () => { order.push('pre'); return [{ decision: hook, reason: hook === 'deny' ? 'blocked by host hook' : 'host hook' }]; }, runPostToolUse: async () => { order.push('post'); if (failure === 'hook') throw Error('post hook failed'); return []; } },
    recordExecution: async (_operation, record) => { order.push('record'); if (failure === 'persist') throw Error('actual result persistence failed'); records.push(record); return { ok: true }; },
    recordPostlude: async (_operation, record) => { order.push('post-record'); if (failure === 'post-persist') throw Error('postlude persistence failed'); postludes.push(record); return { ok: true }; },
    onRuntimeEvent: event => events.push(event) });
  return { runtime, operation, content, file, order, requests, events, records, postludes };
}
test('human conditional edits execute through projection, shared SDK hooks, host permission and actual Provider evidence', async t => {
  const f = fixture(t), actual = await f.runtime.execute({ operation: f.operation, content: f.content });
  assert.equal(readFileSync(f.file, 'utf8'), 'new'); assert.equal(actual.call.capabilityId, RESOURCE_FILE_REPLACE_CAPABILITY); assert.equal(actual.call.toolCallId, 'resource-edit:request');
  assert.equal(actual.grant.grantId, 'real-grant'); assert.equal(actual.result.evidence.toolCallId, actual.call.toolCallId); assert.equal(actual.result.outputPreview.outcome, 'applied');
  assert.deepEqual(f.order, ['pre', 'resolve', 'permission', 'resolve', 'record', 'post', 'post-record']);
  assert.equal(f.requests[0].request.args.content, undefined); assert.equal(f.requests[0].request.args.proposedVersion, hash('new'));
  assert.ok(f.events.some(event => event.type === 'tool.started')); assert.ok(f.events.some(event => event.type === 'tool.completed'));
});
test('host hook denial blocks the Provider and does not produce file writes or a positive grant', async t => {
  const f = fixture(t, 'deny'), actual = await f.runtime.execute({ operation: f.operation, content: f.content });
  assert.equal(readFileSync(f.file, 'utf8'), 'old'); assert.equal(actual.grant.granted, false); assert.equal(actual.result.status, 'denied'); assert.deepEqual(f.order, ['pre', 'record', 'post-record']); assert.equal(f.requests.length, 0);
});
test('prepared/uncertain/settled or mismatched journal bodies cannot dispatch as a fresh running operation', async t => {
  const f = fixture(t);
  for (const phase of ['prepared', 'uncertain', 'settled']) await assert.rejects(f.runtime.execute({ operation: { ...f.operation, phase }, content: f.content }), /INVALID_DISPATCH/);
  await assert.rejects(f.runtime.execute({ operation: f.operation, content: 'different body' }), /INVALID_DISPATCH/);
  await assert.rejects(f.runtime.execute({ operation: { ...f.operation, payloadHash: hash('forged') }, content: f.content }), /INVALID_DISPATCH/);
  assert.equal(readFileSync(f.file, 'utf8'), 'old'); assert.equal(f.events.length, 0);
});


test('original Provider fact is durable before a failing post Hook; governance remains separately unconfirmed', async t => {
  const f = fixture(t, 'allow', 'hook'), actual = await f.runtime.execute({ operation: f.operation, content: f.content });
  assert.equal(readFileSync(f.file, 'utf8'), 'new'); assert.equal(actual.result.outputPreview.outcome, 'applied'); assert.equal(actual.governanceConfirmed, false);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].result.observation.outcome, 'applied'); assert.equal(f.postludes[0].status, 'unconfirmed');
  assert.ok(f.order.indexOf('record') < f.order.indexOf('post')); assert.equal(JSON.stringify(f.records).includes('"content":'), false);
});
test('failure to persist the actual result after writing does not manufacture a durable receipt or rerun the write', async t => {
  const f = fixture(t, 'allow', 'persist'); await assert.rejects(f.runtime.execute({ operation: f.operation, content: f.content }), /persistence failed/);
  assert.equal(readFileSync(f.file, 'utf8'), 'new'); assert.equal(f.records.length, 0); assert.equal(f.order.filter(item => item === 'permission').length, 1); assert.equal(f.order.includes('post'), false);
});
test('postlude storage failure keeps the original durable file result and does not turn it into an execution failure', async t => {
  const f = fixture(t, 'allow', 'post-persist'), actual = await f.runtime.execute({ operation: f.operation, content: f.content });
  assert.equal(actual.governanceConfirmed, false); assert.equal(actual.result.outputPreview.outcome, 'applied'); assert.equal(f.records.length, 1); assert.equal(f.postludes.length, 0);
});
test('an actual scope-less Hook timeout retains its negative Grant and reason without becoming an unknown file result', async t => {
  const f = fixture(t, 'ask', 'permission-timeout'), actual = await f.runtime.execute({ operation: f.operation, content: f.content });
  assert.equal(actual.result.status, 'denied'); assert.equal(f.records[0].grant.grantId, 'real-timeout'); assert.equal(f.records[0].grant.scope, undefined);
  assert.equal(f.records[0].call.permissionCallId, 'chat-permission:resource-edit:request'); assert.equal(f.records[0].result.blockedReason, 'permission_timeout');
  assert.equal(readFileSync(f.file, 'utf8'), 'old');
});
