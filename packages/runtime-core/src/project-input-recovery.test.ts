import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyInputDraft, type ProjectAgentSubmitInputResult, type ProjectInputDraftSnapshot,
  type ProjectInputRecoveryPort, type ProjectInputAttachment, type UnconfirmedProjectInput } from '@peer-agent/protocol';
import { createProjectInputRecovery } from './project-input-recovery.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let stored: ProjectInputDraftSnapshot = { revision: 0, draft: emptyInputDraft(), pending: [] }, nextId = 0;
  const uploads = new Map<string, ProjectInputAttachment>(), calls: UnconfirmedProjectInput[] = [];
  let failWrite = false, loseReceipt = false, release: ReturnType<typeof deferred<ProjectAgentSubmitInputResult>> | null = null;
  const received = (input: UnconfirmedProjectInput): ProjectAgentSubmitInputResult => ({ ok: true, input: {
    ...input, workspaceId: 'ws', surface: 'desktop', anchorRefs: [], attachmentRefs: [],
  } });
  const port: ProjectInputRecoveryPort = {
    read: async () => ({ ok: true, snapshot: structuredClone(stored) }),
    write: async request => {
      if (failWrite) return { ok: false, code: 'DRAFT_SAVE_FAILED' };
      assert.equal(request.revision, stored.revision);
      for (const item of request.uploads) uploads.set(item.id, item);
      const hydrate = (ids: readonly string[]) => ids.map(id => { const item = uploads.get(id); assert.ok(item); return item; });
      const { attachmentIds, ...draft } = request.draft;
      stored = { revision: stored.revision + 1, draft: { ...draft, attachments: hydrate(attachmentIds) },
        pending: request.pending.map(({ attachmentIds, ...input }) => ({ ...input, attachments: hydrate(attachmentIds) })) };
      return { ok: true, revision: stored.revision };
    },
    submit: async input => { calls.push(input); if (release) return release.promise; if (loseReceipt) throw Error('lost'); return received(input); },
  };
  const make = (receiptTimeoutMs?: number) => createProjectInputRecovery({ workspaceId: 'ws', surface: 'desktop', port, receiptTimeoutMs, createId: () => `input-${++nextId}` });
  return { make, calls, port, stored: () => stored, failWrite: () => { failWrite = true; }, lose: () => { loseReceipt = true; },
    defer() { release = deferred<ProjectAgentSubmitInputResult>(); return release; }, received };
}
test('reopening restores the whole draft and pending intent, never automatically sends', async () => {
  const f = fixture(), first = f.make(); await first.load();
  const upload: ProjectInputAttachment = { id: 'file', kind: 'text', name: 'a.txt', mimeType: 'text/plain', size: 4, text: 'data', sourceKind: 'user_upload' };
  first.edit({ text: 'text', quote: { messageId: 'm', text: 'quoted' }, attachments: [upload] }); await first.flush();
  const reopened = f.make(); await reopened.load(); assert.deepEqual(reopened.getSnapshot().draft, first.getSnapshot().draft);
  f.lose(); await reopened.send({ quoteRefs: ['m'] });
  const again = f.make(); await again.load();
  assert.equal(again.getSnapshot().pending[0]?.inputId, f.calls[0]?.inputId);
  assert.deepEqual(again.getSnapshot().pending[0]?.attachments, [upload]);
  assert.equal(f.calls.length, 1);
});
test('save failure preserves the envelope and never reaches the execution queue', async () => {
  const f = fixture(), session = f.make(); await session.load(); session.edit({ text: 'keep' }); await session.flush();
  f.failWrite(); const result = await session.send(); assert.equal(result.ok, false);
  assert.equal(session.getSnapshot().pending[0]?.text, 'keep'); assert.equal(f.calls.length, 0);
});
test('lost receipts and concurrent retry clicks reuse the exact same envelope', async () => {
  const f = fixture(), session = f.make(); await session.load(); session.edit({ text: 'one' }); f.lose();
  await session.send({ quoteRefs: ['origin'], answerTo: 'question' });
  const input = session.getSnapshot().pending[0]!;
  const gate = f.defer(); const a = session.retry(input.inputId), b = session.retry(input.inputId);
  await Promise.resolve(); await Promise.resolve(); gate.resolve(f.received(input)); await Promise.all([a, b]);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(session.getSnapshot().pending.length, 0);
});
test('a late receipt does not clear the next draft; the received echo remains until public history catches up', async () => {
  const f = fixture(), session = f.make(); await session.load(); session.edit({ text: 'old' }); await session.flush();
  const gate = f.defer(); const sending = session.send(); const input = session.getSnapshot().pending[0]!;
  session.edit({ text: 'new draft' }); gate.resolve(f.received(input)); await sending; await session.flush();
  assert.equal(session.getSnapshot().draft.text, 'new draft'); assert.equal(f.stored().draft.text, 'new draft');
  assert.equal(session.getSnapshot().received[0]?.text, 'old');
  session.observeReceived([input.inputId]); assert.equal(session.getSnapshot().received.length, 0);
});
test('generic ok and foreign receipts cannot acknowledge local input; a real receipt with handoff failure can', async () => {
  for (const wrong of [{ ok: true }, { ok: true, input: { workspaceId: 'other', inputId: 'input-1' } }] as ProjectAgentSubmitInputResult[]) {
    const f = fixture(); f.port.submit = async () => wrong; const session = f.make(); await session.load(); session.edit({ text: 'pending' });
    assert.equal((await session.send()).ok, false); assert.equal(session.getSnapshot().pending.length, 1);
  }
  const f = fixture(); f.port.submit = async input => ({ ...f.received(input), ok: false, code: 'HANDOFF_FAILED' });
  const session = f.make(); await session.load(); session.edit({ text: 'accepted' });
  assert.equal((await session.send()).code, 'HANDOFF_FAILED'); assert.equal(session.getSnapshot().pending.length, 0);
});
test('question button retries preserve one answer identity and do not clear an unrelated draft', async () => {
  const f = fixture(), session = f.make(); await session.load(); session.edit({ text: 'unrelated draft' }); f.lose();
  await session.send({ text: 'yes', answerTo: 'question', useDraft: false });
  await session.send({ text: 'yes', answerTo: 'question', useDraft: false });
  assert.equal(f.calls[0]?.inputId, f.calls[1]?.inputId);
  assert.equal((await session.send({ text: 'no', answerTo: 'question', useDraft: false })).code, 'INPUT_PENDING_ANSWER');
  assert.equal(session.getSnapshot().draft.text, 'unrelated draft');
});
test('an early quote edit merges with the persisted text and attachments after hydration', async () => {
  const f = fixture(), first = f.make(); await first.load(); first.edit({ text: 'persisted' }); await first.flush();
  const next = f.make(); next.edit({ quote: { messageId: 'm', text: 'quote' } }); await next.load(); await next.flush();
  assert.equal(next.getSnapshot().draft.text, 'persisted'); assert.equal(next.getSnapshot().draft.quote?.messageId, 'm');
});

test('a presentation deadline preserves unknown intent; a late receipt only acknowledges the original input', async () => {
  const f = fixture(), session = f.make(1); await session.load(); session.edit({ text: 'old' });
  const gate = f.defer(); const result = await session.send(); const input = session.getSnapshot().pending[0]!;
  assert.equal(result.code, 'INPUT_OUTCOME_UNKNOWN'); assert.equal(session.getSnapshot().sending.length, 0);
  session.edit({ text: 'next draft' }); gate.resolve(f.received(input)); await Promise.resolve(); await Promise.resolve();
  assert.equal(session.getSnapshot().pending.length, 0); assert.equal(session.getSnapshot().draft.text, 'next draft');
  assert.equal(f.calls.length, 1);
});
test('a stale native editor value cannot allocate another input after a first submit cleared the draft', async () => {
  const f = fixture(), session = f.make(); await session.load(); session.edit({ text: 'send once' }); f.lose();
  await session.send({ text: 'send once' });
  assert.equal((await session.send({ text: 'send once' })).code, 'INPUT_CHANGED'); assert.equal(f.calls.length, 1);
});
