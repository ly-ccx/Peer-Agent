import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResourceEditTarget, normalizeResourceTextDraft, normalizeResourceEditReceipt, normalizeResourceEditOperation, validResourceEditText } from './resource-edit.ts';
const hash = `sha256:${'a'.repeat(64)}`;
const target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/repo/doc.md' }, base: { resourceId: hash, contentVersion: hash } };
test('edit target is an explicit current file and recipient, never a history locator, directory, relative guess or authority object', () => {
  const normalized = normalizeResourceEditTarget(target)!; assert.equal(normalized.reference.kind, 'file'); assert.equal(normalized.reference.expectedObservation?.contentVersion, hash);
  const references = [{ ...target.reference, path: 'doc.md' }, { ...target.reference, kind: 'directory' }, { ...target.reference, revision: { kind: 'git', commit: 'a'.repeat(40) } },
    { ...target.reference, relativeTo: '/repo' }, { ...target.reference, workspaceId: 'other' }, { ...target.reference, permission: 'all' }];
  for (const reference of references) assert.equal(normalizeResourceEditTarget({ ...target, reference }), undefined);
  assert.equal(normalizeResourceEditTarget({ ...target, writer: true }), undefined);
});
test('valid text preserves exact Unicode and line endings; byte oversize, NUL and broken surrogate code units fail', () => {
  for (const text of ['', 'a\r\nb', '你好🙂']) assert.equal(validResourceEditText(text), true);
  for (const text of ['\ud800', '\udc00', 'a\u0000b', '你'.repeat(400_000)]) assert.equal(validResourceEditText(text), false);
  const draft = { id: 'draft', target, baseText: 'base', text: '', revision: 0, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
  assert.equal(normalizeResourceTextDraft(draft)?.text, ''); assert.equal(normalizeResourceTextDraft({ ...draft, schemaVersion: 2 }), undefined);
});
test('an applied receipt needs tool/Evidence linkage and matching observed version; malformed extra facts are rejected', () => {
  assert.equal(normalizeResourceEditReceipt({ outcome: 'applied', observedVersion: hash }), undefined);
  assert.equal(normalizeResourceEditReceipt({ outcome: 'failed', toolCallId: 'call' }), undefined);
  const receipt = { outcome: 'applied', toolCallId: 'call', evidenceRef: 'evidence://ref', observedVersion: hash };
  assert.equal(normalizeResourceEditReceipt(receipt)?.outcome, 'applied');
  const operation = { requestId: 'request', draftId: 'draft', draftRevision: 0, target, providerId: 'local.file', proposedVersion: hash, payloadHash: hash,
    createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', phase: 'settled', hostEpoch: 'host', receipt };
  assert.equal(normalizeResourceEditOperation(operation)?.receipt?.toolCallId, 'call');
  assert.equal(normalizeResourceEditOperation({ ...operation, receipt: { ...receipt, observedVersion: `sha256:${'b'.repeat(64)}` } }), undefined);
  assert.equal(normalizeResourceEditOperation({ ...operation, phase: 'prepared', hostEpoch: undefined, receipt: { broken: true } }), undefined);
  assert.equal(normalizeResourceEditOperation({ ...operation, phase: 'running', receipt: undefined, hostEpoch: undefined }), undefined);
});
test('text snapshots bind provenance and purpose without claiming current file permission or acceptance', async () => {
  const { normalizeResourceTextSnapshot } = await import('./resource-edit.ts');
  const snapshot = { id: 'snapshot', target, version: hash, createdAt: '2026-10-27T00:00:00Z', purpose: 'delivery', availability: 'retained', evidenceRef: 'evidence://actual', artifactRef: 'artifact://file' };
  assert.equal(normalizeResourceTextSnapshot(snapshot)?.purpose, 'delivery');
  assert.equal(normalizeResourceTextSnapshot({ ...snapshot, permission: 'allow' }), undefined);
  assert.equal(normalizeResourceTextSnapshot({ ...snapshot, version: `sha256:${'b'.repeat(64)}` }), undefined);
  assert.equal(normalizeResourceTextSnapshot({ ...snapshot, artifactRef: undefined }), undefined);
  const before = { ...snapshot, purpose: 'before', operationId: 'actual-operation', toolCallId: 'actual-call', artifactRef: undefined };
  assert.equal(normalizeResourceTextSnapshot(before)?.purpose, 'before');
  assert.equal(normalizeResourceTextSnapshot({ ...before, toolCallId: undefined }), undefined);
});
test('edit source carries only a read observation and actual native lease; source bodies and asserted owners are rejected', async () => {
  const { normalizeResourceEditSource, normalizeResourceEditHandle } = await import('./resource-edit.ts');
  const source = { kind: 'document', reference: target.reference, observed: target.base };
  assert.equal(normalizeResourceEditSource(source)?.kind, 'document');
  assert.equal(normalizeResourceEditSource({ ...source, baseText: 'injected' }), undefined);
  assert.equal(normalizeResourceEditSource({ ...source, recipient: target.recipient }), undefined);
  const native = { kind: 'native', identity: { viewId: 'view', windowId: 'window', generation: 1 }, path: '/repo/a.md', observed: target.base };
  assert.equal(normalizeResourceEditSource(native)?.kind, 'native'); assert.equal(normalizeResourceEditSource({ ...native, path: '../other' }), undefined);
  assert.equal(normalizeResourceEditSource({ ...native, identity: { ...native.identity, owner: 'other' } }), undefined);
  assert.equal(normalizeResourceEditHandle({ viewId: 'view', windowId: 'window', generation: 1, draftId: 'draft', writer: true }), undefined);
});
