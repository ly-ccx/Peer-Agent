import assert from 'node:assert/strict';
import test from 'node:test';
import { interactiveFeedbackFromFollowup, type ResourceFeedback } from './resource-feedback.ts';
import { encodeResourceFeedbackTransport, interactiveFeedbackAttachment, projectResourceFeedbackTransport,
  readInteractiveFeedbackAttachment, restoreResourceFeedbackTransport } from './resource-feedback-transport.ts';

const hash = (n: string) => `sha256:${n.repeat(64)}`;
const owner = { workspaceId: 'bot', conversationId: 'parent' };
const feedback = interactiveFeedbackFromFollowup({ followupId: 'selection', recipient: owner,
  result: { owner, resultId: 'result', contentVersion: hash('a') }, specHash: hash('b'), stateRevision: 3,
  stateDigest: hash('c'), selectionDigest: hash('d'), values: { $x: 4, $name: '固定条件' }, dataLevel: 'D3_private',
  capturedAt: '2026-11-03T00:00:00.000Z', excerpt: 'Selected conditions' })!;
assert.ok(feedback);

test('the wire carrier is lossless, stable under object key order and idempotent across legacy normalization', () => {
  const carrier = interactiveFeedbackAttachment(feedback);
  const reordered = Object.fromEntries(Object.entries(carrier).reverse()) as typeof carrier;
  assert.deepEqual(readInteractiveFeedbackAttachment(reordered), feedback);
  const once = encodeResourceFeedbackTransport([feedback]);
  assert.deepEqual(restoreResourceFeedbackTransport(once.resourceFeedback, once.attachments), [feedback]);
  assert.deepEqual(encodeResourceFeedbackTransport([feedback], [reordered]), once);
  assert.equal(once.resourceFeedback, undefined);
});

test('future schemas, changed metadata and conflicting IDs never become an empty successful feedback list', () => {
  const carrier = interactiveFeedbackAttachment(feedback);
  assert.equal(carrier.kind, 'text');
  if (carrier.kind !== 'text') throw Error('expected text');
  for (const corrupted of [
    { ...carrier, text: carrier.text.replace('peer-interactive-selection-1', 'peer-interactive-selection-2') },
    { ...carrier, text: '{' }, { ...carrier, size: carrier.size + 1 }, { ...carrier, name: 'other.json' },
    { ...carrier, permissionGrant: true }, { ...carrier, sourceKind: 'not-uploaded' },
  ]) {
    assert.throws(() => restoreResourceFeedbackTransport(undefined, [corrupted]));
    const projected = projectResourceFeedbackTransport(undefined, [corrupted]);
    assert.equal(projected.invalid, true); assert.deepEqual(projected.attachments, [corrupted]);
  }
  const changed = { ...feedback, excerpt: 'different conditions' };
  assert.throws(() => restoreResourceFeedbackTransport([feedback], [interactiveFeedbackAttachment(changed)]), /ID_CONFLICT/);
});

test('a user-context projection deduplicates only valid carriers and leaves ordinary user attachments intact', () => {
  const document = { id: 'document', kind: 'text', text: 'ordinary user material' };
  const carrier = interactiveFeedbackAttachment(feedback), original = [document, carrier];
  const before = JSON.stringify(original), projected = projectResourceFeedbackTransport(undefined, original);
  assert.deepEqual(projected.resourceFeedback, [feedback]); assert.deepEqual(projected.attachments, [document]);
  assert.equal(projected.invalid, false); assert.equal(JSON.stringify(original), before);
  const all = Array.from({ length: 8 }, (_, i) => ({ ...document, id: `file-${i}`, name: 'a.txt', mimeType: 'text/plain', size: 3, sourceKind: 'user_upload' as const, kind: 'text' as const }));
  assert.throws(() => encodeResourceFeedbackTransport([feedback], all), /ATTACHMENT_LIMIT/);
  assert.throws(() => restoreResourceFeedbackTransport(Array(9).fill(feedback) as ResourceFeedback[]), /INVALID_RESOURCE_FEEDBACK/);
});
