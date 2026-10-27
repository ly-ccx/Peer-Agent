import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectInputDraftStore } from './input-draft-store.mjs';
import { createInputQueue } from './input-queue.mjs';
import { resourceFeedbackFromMessages } from './session-supervisor.mjs';
const hash = 'sha256:' + 'a'.repeat(64);
const feedback = { id: 'selection-a', recipient: { workspaceId: 'bot', conversationId: 'conversation-a' }, capturedAt: '2026-10-27T00:00:00.000Z',
  resource: { kind: 'document', mode: 'preview', reference: { workspaceId: 'bot', path: '/repo/a.md', kind: 'file' } }, version: { kind: 'content', resourceId: hash, contentVersion: hash },
  excerpt: 'chosen material', selection: { kind: 'discussion' } };
const address = { workspaceId: 'bot', surface: 'desktop' };
function root(t) { const root = mkdtempSync(path.join(os.tmpdir(), 'peer-feedback-input-')); t.after(() => rmSync(root, { force: true, recursive: true })); return root; }
test('feedback drafts and pending inputs persist as v2 without queue submission; corrupt/future/foreign rows preserve the last record', t => {
  const dir = root(t), store = createProjectInputDraftStore({ rootDir: dir });
  const request = { ...address, revision: 0, draft: { text: 'question', quote: null, attachmentIds: [], resourceFeedback: [feedback] },
    pending: [{ inputId: 'in-1', text: 'older question', createdAt: feedback.capturedAt, quoteRefs: [], attachmentIds: [], resourceFeedback: [feedback] }], uploads: [] };
  assert.equal(store.write(request).ok, true);
  const file = path.join(dir, 'bot/input-drafts/desktop.json'), bytes = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(bytes).schemaVersion, 2);
  const reopened = createProjectInputDraftStore({ rootDir: dir }).read(address); assert.equal(reopened.ok, true);
  assert.deepEqual(reopened.snapshot.draft.resourceFeedback, [feedback]); assert.deepEqual(reopened.snapshot.pending[0].resourceFeedback, [feedback]);
  assert.equal(store.write({ ...request, revision: 1, draft: { ...request.draft, resourceFeedback: [{ ...feedback, recipient: { ...feedback.recipient, workspaceId: 'other' } }] } }).ok, false);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(bytes), schemaVersion: 999 })); const future = readFileSync(file, 'utf8');
  assert.equal(store.read(address).ok, false); assert.equal(store.write({ ...request, revision: 1 }).ok, false); assert.equal(readFileSync(file, 'utf8'), future);
});
test('queue routes feedback to its captured recipient, clones cache, and reuses the first accepted input on retry', t => {
  const dir = root(t), messages = []; let conversation = 'conversation-a';
  const queue = createInputQueue({ rootDir: dir, holdsLease: () => true, resolveConversationId: () => conversation,
    hasMessage: (_id, id) => messages.some(m => m.id === id), appendMessage: (_id, message) => messages.push(message) });
  const input = { ...address, inputId: 'in-1', text: 'question', resourceFeedback: [feedback] };
  assert.equal(queue.submitInput(input).resourceFeedback.length, 1);
  queue.consume('bot'); queue.consume('bot'); assert.equal(messages.length, 1); assert.deepEqual(messages[0].resourceFeedback, [feedback]);
  const one = queue.submitInput(input); one.resourceFeedback[0].resource.reference.path = '/wrong';
  assert.equal(queue.submitInput(input).resourceFeedback[0].resource.reference.path, '/repo/a.md');
  conversation = 'conversation-b';
  assert.equal(queue.submitInput(input).inputId, 'in-1');
  assert.throws(() => queue.submitInput({ ...input, inputId: 'in-2' }), /RECIPIENT_CHANGED/);
  assert.throws(() => queue.pendingExecution('bot'), /RECIPIENT_CHANGED/); assert.equal(messages.length, 1);
});
test('recipient changes before consume leave the accepted queue intact and write no message', t => {
  const dir = root(t), messages = []; let conversation = 'conversation-a';
  const queue = createInputQueue({ rootDir: dir, holdsLease: () => true, resolveConversationId: () => conversation, hasMessage: () => false, appendMessage: (...args) => messages.push(args) });
  queue.submitInput({ ...address, inputId: 'in-1', text: 'question', resourceFeedback: [feedback] });
  const file = path.join(dir, 'bot/input-queue.jsonl'), bytes = readFileSync(file, 'utf8'); conversation = 'conversation-b';
  assert.throws(() => queue.consume('bot'), /RECIPIENT_CHANGED/); assert.equal(messages.length, 0); assert.equal(readFileSync(file, 'utf8'), bytes);
});
test('delegation admits only explicit anchor feedback and rejects conflicting identities', () => {
  const hidden = { ...feedback, id: 'other', excerpt: 'not selected' };
  const messages = [{ id: 'chosen', resourceFeedback: [feedback] }, { id: 'unrelated', resourceFeedback: [hidden] }];
  assert.deepEqual(resourceFeedbackFromMessages(messages, ['chosen']), [feedback]);
  assert.deepEqual(resourceFeedbackFromMessages(messages, []), []);
  assert.throws(() => resourceFeedbackFromMessages([...messages, { id: 'conflict', resourceFeedback: [{ ...feedback, excerpt: 'changed' }] }], ['chosen', 'conflict']), /ID_CONFLICT/);
});
