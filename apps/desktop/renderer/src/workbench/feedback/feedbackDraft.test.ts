import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '@peer-agent/protocol';
const hash = 'sha256:' + 'a'.repeat(64);
const feedback: protocol.ResourceFeedback = { id: 'selection-a', recipient: { workspaceId: 'bot-a', conversationId: 'conversation-a' }, capturedAt: '2026-10-27T00:00:00.000Z',
  resource: { kind: 'document', mode: 'preview', reference: { workspaceId: 'bot-a', path: '/repo/a.md' } }, version: { kind: 'content', resourceId: hash, contentVersion: hash },
  excerpt: 'selected', selection: { kind: 'discussion' } };
function harness() {
  const sessions = new Map<string, any>(), edits: any[] = []; let saves = true;
  const inputRecoveryFor = (id: string) => {
    if (!sessions.has(id)) {
      let state = { ready: false, error: null, draft: { text: 'keep draft', quote: { messageId: 'm', text: 'keep quote' }, attachments: [{ id: 'upload' }], resourceFeedback: [] } };
      sessions.set(id, { getSnapshot: () => state, async load() { state = { ...state, ready: true }; return true; },
        edit(patch: any) { edits.push({ id, patch }); state = { ...state, draft: { ...state.draft, ...patch } }; }, async flush() { return saves; } });
    }
    return sessions.get(id);
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./feedbackDraft.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require(id: string) { if (id === '@peer-agent/protocol') return protocol; if (id === '../../project-agent/state/useInputRecovery') return { inputRecoveryFor }; throw Error(id); } });
  return { prepare: exports.prepareResourceFeedbackDraft, session: inputRecoveryFor, edits, fail: () => { saves = false; }, recover: () => { saves = true; } };
}
test('preparing a reference preserves text/quote/uploads and targets the captured Bot without sending', async () => {
  const h = harness(); const other = h.session('bot-b').getSnapshot();
  assert.equal((await h.prepare(feedback)).ok, true);
  const draft = h.session('bot-a').getSnapshot().draft;
  assert.equal(draft.text, 'keep draft'); assert.equal(draft.quote.messageId, 'm'); assert.equal(draft.attachments[0].id, 'upload');
  assert.equal(draft.resourceFeedback[0].recipient.conversationId, 'conversation-a'); assert.equal(h.session('bot-b').getSnapshot(), other);
  assert.equal(h.edits.length, 1); assert.equal((await h.prepare(feedback)).ok, true); assert.equal(h.edits.length, 1);
});
test('unconfirmed save retains the same excerpt; retry does not append duplicates or reinterpret its ID', async () => {
  const h = harness(); h.fail(); assert.equal((await h.prepare(feedback)).ok, false);
  assert.equal(h.session('bot-a').getSnapshot().draft.resourceFeedback.length, 1);
  h.recover(); assert.equal((await h.prepare(feedback)).ok, true); assert.equal(h.edits.length, 1);
  assert.equal((await h.prepare({ ...feedback, excerpt: 'another' })).code, 'RESOURCE_FEEDBACK_ID_CONFLICT');
});

test('frozen conditions reserve a legacy attachment slot before editing the existing Composer draft', async () => {
  const row = protocol.interactiveFeedbackFromFollowup({ followupId: 'frozen', recipient: feedback.recipient,
    result: { owner: feedback.recipient, resultId: 'result', contentVersion: hash }, specHash: hash, stateRevision: 1,
    stateDigest: hash, selectionDigest: hash, values: { $x: 4 }, dataLevel: 'D3_private', capturedAt: feedback.capturedAt, excerpt: 'Conditions' })!;
  const h = harness(), session = h.session('bot-a');
  session.edit({ attachments: Array.from({ length: 8 }, (_, i) => ({ id: `upload-${i}` })) });
  const original = JSON.stringify(session.getSnapshot().draft), edits = h.edits.length;
  assert.equal((await h.prepare(row)).code, 'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT');
  assert.equal(h.edits.length, edits); assert.equal(JSON.stringify(session.getSnapshot().draft), original);
  session.edit({ attachments: [{ id: 'upload' }] });
  assert.equal((await h.prepare(row)).ok, true);
  assert.equal(session.getSnapshot().draft.text, 'keep draft'); assert.equal(session.getSnapshot().draft.quote.text, 'keep quote');
  assert.deepEqual(session.getSnapshot().draft.attachments, [{ id: 'upload' }]);
  assert.equal(session.getSnapshot().draft.resourceFeedback[0].version.values.$x, 4);
});
