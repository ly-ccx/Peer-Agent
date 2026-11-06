import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { RESOURCE_FILE_REPLACE_CAPABILITY as capabilityId, RESOURCE_FILE_REPLACE_PROVIDER as providerId, RESOURCE_FILE_REPLACE_TOOL as toolName, resourceFileReplaceArgumentPayload, resourceEditExecutionReceipt } from '@peer-agent/protocol';
import { createResourceEditStorage } from './resource-edit-storage.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const time = '2026-10-27T03:00:00.000Z';
function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-actual-result-')), stores = [];
  const create = () => { const store = createResourceEditStorage({ rootDir }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const store = create(), target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/fixture/not-opened-by-store.md' }, base: { resourceId: hash('identity'), contentVersion: hash('base') } };
  assert.equal(store.apply('bot', { type: 'open', id: 'draft', target, baseText: 'base' }).ok, true);
  const writer = store.apply('bot', { type: 'acquire', draftId: 'draft', writer: { viewId: 'view', windowId: 'window', generation: 1, token: 'token' } }).writer;
  assert.equal(store.apply('bot', { type: 'edit', draftId: 'draft', revision: 0, writer, text: 'private proposed 汉字' }).ok, true);
  const reserve = (requestId = 'request') => store.apply('bot', { type: 'reserve', requestId, draftId: 'draft', revision: 1, writer, providerId, proposedVersion: hash('private proposed 汉字') });
  const start = (requestId = 'request') => { const reserved = reserve(requestId); assert.equal(reserved.ok, true); const started = store.apply('bot', { type: 'start', requestId, payloadHash: reserved.operation.payloadHash }); assert.equal(started.ok, true); return started.operation; };
  return { store, writer, create, reserve, start, file: path.join(rootDir, 'bot', 'resource-edits', 'store.sqlite') };
}
function record(operation, content = 'private proposed 汉字') {
  const id = `resource-edit:${operation.requestId}`;
  return { schemaVersion: 1, workspaceId: 'bot', requestId: operation.requestId, payloadHash: operation.payloadHash, projectionId: `resource-edit:${operation.requestId}`, sessionId: 'main',
    call: { toolCallId: id, capabilityId, toolName, argumentsDigest: hash(resourceFileReplaceArgumentPayload({ requestId: operation.requestId, target: operation.target, content, proposedVersion: operation.proposedVersion })), occurredAt: time },
    grant: { grantId: 'actual-grant', toolCallId: id, granted: true, duration: 'once', scope: capabilityId, decidedAt: time },
    result: { toolCallId: id, status: 'success', completedAt: time, observation: { kind: 'resource_file_replace_result', requestId: operation.requestId, path: operation.target.reference.path,
      resourceId: operation.target.base.resourceId, expectedVersion: operation.target.base.contentVersion, proposedVersion: operation.proposedVersion, observedVersion: operation.proposedVersion, status: 'success', outcome: 'applied', effectStarted: true },
      evidence: { evidenceId: 'actual-evidence', toolCallId: id, summary: 'Actual fixture provider result.', locale: 'en-US', returnedToCloud: false, dataLevel: 'D2_sensitive', redactions: [], artifactRefs: [] } } };
}
test('actual result is immutable/idempotent, body-free, and remains available after settlement/archive/body cleanup', t => {
  const f = fixture(t), op = f.start(), raw = record(op); assert.equal(f.store.recordExecution('bot', raw).ok, true);
  assert.equal(f.store.recordExecution('bot', raw).repeated, true); assert.equal(f.store.recordExecution('bot', { ...raw, result: { ...raw.result, evidence: { ...raw.result.evidence, summary: 'contradiction' } } }).code, 'RESOURCE_EDIT_EXECUTION_CONFLICT');
  assert.equal(f.store.apply('bot', { type: 'settle', requestId: op.requestId, receipt: resourceEditExecutionReceipt(raw, op) }).ok, true);
  assert.equal(f.store.cleanup('bot', [op.requestId]).ok, true); assert.equal(f.store.apply('bot', { type: 'archive', requestId: op.requestId }).ok, true);
  assert.equal(f.store.executionResult('bot', op.requestId).record.result.evidence.evidenceId, 'actual-evidence');
  const db = new DatabaseSync(f.file, { readOnly: true }), value = db.prepare('SELECT value FROM execution_results').get().value; db.close();
  assert.equal(value.includes('private proposed 汉字'), false); assert.equal(value.includes('"arguments":'), false);
});
test('mismatched call/evidence, target observation, input digest or unapplied grant cannot be inserted as success', t => {
  const f = fixture(t), op = f.start(), raw = record(op);
  for (const altered of [ { ...raw, call: { ...raw.call, argumentsDigest: hash('wrong body') } }, { ...raw, result: { ...raw.result, evidence: { ...raw.result.evidence, toolCallId: 'wrong-call' } } },
    { ...raw, grant: { ...raw.grant, granted: false, duration: 'denied' } }, { ...raw, result: { ...raw.result, observation: { ...raw.result.observation, path: '/other/file' } } } ]) assert.equal(f.store.recordExecution('bot', altered).ok, false);
  assert.equal(f.store.executionResult('bot', op.requestId).code, 'RESOURCE_EDIT_EXECUTION_MISSING');
});
test('postlude has independent provenance, upgrades unknown only to actual recorded governance, and cannot replace an original fact', t => {
  const f = fixture(t), op = f.start(), raw = record(op); f.store.recordExecution('bot', raw);
  const unknown = { schemaVersion: 1, requestId: op.requestId, payloadHash: op.payloadHash, completedAt: time, status: 'unconfirmed', reason: 'post_hook_unavailable' };
  assert.equal(f.store.recordExecutionPostlude('bot', unknown).ok, true);
  const actual = { ...unknown, status: 'recorded', reason: undefined, hooks: [{ event: 'PostToolUse', decision: 'allow' }] };
  assert.equal(f.store.recordExecutionPostlude('bot', actual).ok, true); assert.equal(f.store.recordExecutionPostlude('bot', unknown).code, 'RESOURCE_EDIT_EXECUTION_CONFLICT');
  assert.equal(f.store.executionResult('bot', op.requestId).record.result.observation.outcome, 'applied');
});
test('v1 migration preserves original drafts; a live old host or corrupt old manifest blocks migration without schema overwrite', t => {
  const f = fixture(t); f.store.close(); let db = new DatabaseSync(f.file); db.exec('DROP TABLE execution_results; PRAGMA user_version=1;'); db.close();
  const migrated = f.create(); assert.equal(migrated.readDraft('bot', 'draft').draft.text, 'private proposed 汉字'); migrated.close();
  db = new DatabaseSync(f.file); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2); db.exec('DROP TABLE execution_results; PRAGMA user_version=1;');
  db.prepare('INSERT OR REPLACE INTO host_owner VALUES(1,?,?)').run(process.pid, 'still-live-old-host'); db.close();
  assert.equal(f.create().inspect('bot').code, 'RESOURCE_EDIT_HOST_BUSY');
  db = new DatabaseSync(f.file); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); db.exec('DELETE FROM host_owner;'); db.prepare('UPDATE manifest SET value=?').run('{broken'); db.close();
  assert.equal(f.create().inspect('bot').code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  db = new DatabaseSync(f.file); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(db.prepare('SELECT value FROM manifest').get().value, '{broken'); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='execution_results'").get().n, 0); db.close();
});
test('raw result corruption is detected on receipt lookup even after an index was cached', t => {
  const f = fixture(t), op = f.start(); f.store.recordExecution('bot', record(op)); f.store.inspect('bot');
  const db = new DatabaseSync(f.file); const value = db.prepare('SELECT value FROM execution_results').get().value; db.prepare('UPDATE execution_results SET value=?').run(value.replace('Actual fixture', 'Changed record')); db.close();
  assert.equal(f.store.executionResult('bot', op.requestId).code, 'RESOURCE_EDIT_STORAGE_UNAVAILABLE');
});
test('execution quota is reserved before start; no old result or body is silently removed to admit another operation', t => {
  const f = fixture(t); let stopped = false, count = 0;
  for (let i = 0; i < 400; i++) {
    const requestId = `request-${i}`, reserved = f.reserve(requestId);
    if (!reserved.ok) { assert.equal(reserved.code, 'RESOURCE_EDIT_EXECUTION_LIMIT'); assert.equal(f.store.inspect('bot').manifest.operations.some(op => op.requestId === requestId), false); stopped = true; break; }
    const started = f.store.apply('bot', { type: 'start', requestId, payloadHash: reserved.operation.payloadHash }), raw = record(started.operation);
    raw.result.evidence.summary = 's'.repeat(4000); raw.result.evidence.artifactRefs = Array.from({ length: 24 }, (_, n) => `artifact://${n}/` + 'x'.repeat(800));
    assert.equal(f.store.recordExecution('bot', raw).ok, true); f.store.apply('bot', { type: 'settle', requestId, receipt: resourceEditExecutionReceipt(raw, started.operation) }); f.store.apply('bot', { type: 'archive', requestId }); count++;
  }
  assert.equal(stopped, true); assert.ok(count > 0); assert.equal(f.store.executionResult('bot', 'request-0').ok, true);
});
