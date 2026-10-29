import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectInputRecovery } from '@peer-agent/runtime-core';
import { emptyInputDraft, type ProjectInputRecoveryPort, type ProjectInputAttachment } from '@peer-agent/protocol';
import { composerInputKeys, conversationInputKeys, createInputRecoveryProjection } from './inputRecoveryProjection.ts';

function fixture() {
  let revision = 0, failedSave = false, accept = false;
  const writes: Parameters<ProjectInputRecoveryPort['write']>[0][] = [];
  const inputs: Parameters<ProjectInputRecoveryPort['submit']>[0][] = [];
  const session = createProjectInputRecovery({ workspaceId: 'bot', surface: 'desktop', createId: () => 'input-1', port: {
    read: async () => ({ ok: true, snapshot: { revision: 0, draft: emptyInputDraft(), pending: [] } }),
    write: async request => {
      writes.push(request);
      return failedSave ? { ok: false, code: 'DRAFT_SAVE_FAILED' } : { ok: true, revision: ++revision };
    },
    submit: async request => {
      inputs.push(request);
      return accept ? { ok: true, input: { ...request, anchorRefs: [], attachmentRefs: [] } }
        : { ok: false, code: 'INPUT_OUTCOME_UNKNOWN' };
    },
  } });
  return { session, writes, inputs, failSave: () => { failedSave = true; }, recoverSave: () => { failedSave = false; }, accept: () => { accept = true; } };
}

test('typing updates the composer immediately without invalidating history on edits or save receipts', async () => {
  const { session, writes } = fixture();
  await session.load();
  const history = createInputRecoveryProjection(session.getSnapshot, conversationInputKeys);
  const composer = createInputRecoveryProjection(session.getSnapshot, composerInputKeys);
  const initialHistory = history();
  let previousComposer = composer(), composerChanges = 0, historyChanges = 0;
  const off = session.subscribe(() => {
    if (history() !== initialHistory) historyChanges++;
    const next = composer();
    if (next !== previousComposer) composerChanges++;
    previousComposer = next;
  });
  try {
    for (let index = 1; index <= 100; index++) {
      const text = '中'.repeat(index);
      session.edit({ text });
      assert.equal(composer().draft.text, text);
      const edited = composer();
      await session.flush();
      assert.equal(composer(), edited, 'saving a revision must not render unchanged draft content again');
    }
    assert.equal(historyChanges, 0);
    assert.equal(composerChanges, 100);
    assert.equal(writes.at(-1)?.draft.text, '中'.repeat(100), 'isolation must not defer or lose persistence');
  } finally { off(); }
});

test('send and retry still publish queue transitions and use the latest text, quote and attachment', async () => {
  const f = fixture(), session = f.session;
  const history = createInputRecoveryProjection(session.getSnapshot, conversationInputKeys);
  const loading = history(); await session.load();
  assert.notEqual(history(), loading);
  const ready = history();
  const file: ProjectInputAttachment = { id: 'file', kind: 'text', name: 'note.txt', mimeType: 'text/plain', size: 4, text: 'note', sourceKind: 'user_upload' };
  session.edit({ text: 'first', attachments: [file], quote: { messageId: 'reply-1', text: 'quoted' } });
  session.edit({ text: 'latest' });
  assert.equal(history(), ready);
  const result = await session.send({ quoteRefs: ['reply-1', 'quoted'] });
  assert.equal(result.code, 'INPUT_OUTCOME_UNKNOWN');
  assert.notEqual(history(), ready);
  assert.equal(history().pending[0]?.text, 'latest');
  assert.deepEqual(f.inputs[0]?.attachments, [file]);
  assert.deepEqual(f.inputs[0]?.quoteRefs, ['reply-1', 'quoted']);
  assert.deepEqual(session.getSnapshot().draft, emptyInputDraft());
  session.edit({ text: 'next draft' });
  f.accept(); await session.retry('input-1');
  assert.equal(history().pending.length, 0);
  assert.equal(history().received[0]?.inputId, 'input-1');
  assert.deepEqual(f.inputs[1], f.inputs[0]);
  assert.equal(session.getSnapshot().draft.text, 'next draft');
  session.observeReceived(['input-1']);
  assert.equal(history().received.length, 0);
});

test('save errors reach the input area without disturbing history or discarding the draft', async () => {
  const f = fixture(); await f.session.load();
  const history = createInputRecoveryProjection(f.session.getSnapshot, conversationInputKeys);
  const composer = createInputRecoveryProjection(f.session.getSnapshot, composerInputKeys);
  const initial = history();
  f.failSave(); f.session.edit({ text: 'preserve me' }); await f.session.flush();
  assert.equal(composer().error, 'DRAFT_SAVE_FAILED');
  assert.equal(composer().draft.text, 'preserve me');
  assert.equal(history(), initial);
  f.recoverSave(); await f.session.flush();
  assert.equal(composer().error, null);
  assert.equal(composer().draft.text, 'preserve me');
  assert.equal(history(), initial);
});
