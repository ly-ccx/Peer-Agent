import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyInputDraft, type ProjectAgentSubmitInputResult, type ProjectInputDraftSnapshot,
  type ProjectInputRecoveryPort, type ProjectInputAttachment, type UnconfirmedProjectInput } from '@peer-agent/protocol';
import { createProjectInputRecovery } from './project-input-recovery.ts';
import { interactiveFeedbackFromFollowup } from '@peer-agent/protocol';

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

test('explicit condition-only sends use the original queue and combined quota failure preserves the whole draft before allocating input', async () => {
  const hash = `sha256:${'a'.repeat(64)}`, owner = { workspaceId: 'ws', conversationId: 'parent' };
  const feedback = interactiveFeedbackFromFollowup({ followupId: 'selection', recipient: owner,
    result: { owner, resultId: 'result', contentVersion: hash }, specHash: hash, stateRevision: 1, stateDigest: hash, selectionDigest: hash,
    values: { $x: 4 }, dataLevel: 'D3_private', capturedAt: '2026-11-03T00:00:00.000Z', excerpt: 'Conditions' })!;
  const f = fixture(), session = f.make(); await session.load();
  const uploads: ProjectInputAttachment[] = Array.from({ length: 100 }, (_, i) => ({ id: `upload-${i}`, name: 'a.txt', kind: 'text', sourceKind: 'user_upload', mimeType: 'text/plain', text: 'a', size: 1 }));
  session.edit({ text: 'Original draft', quote: { messageId: 'quoted', text: 'Original quote' }, attachments: uploads, resourceFeedback: [feedback] });
  const before = structuredClone(session.getSnapshot().draft);
  assert.equal((await session.send()).code, 'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT');
  assert.deepEqual(session.getSnapshot().draft, before); assert.equal(session.getSnapshot().pending.length, 0); assert.equal(f.calls.length, 0);
  session.edit({ text: '', attachments: [] }); await session.flush(); assert.equal(f.calls.length, 0);
  assert.equal((await session.send()).ok, true); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.resourceFeedback, [feedback]); assert.equal(f.calls[0]!.text, '');
});
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

test('resource feedback survives pending input recovery/retry; later draft edits cannot retarget it or auto-submit it', async () => {
  const f = fixture(), session = f.make(); await session.load();
  const hash = 'sha256:' + 'a'.repeat(64);
  const feedback = { id: 'selection-a', recipient: { workspaceId: 'ws', conversationId: 'conversation-a' }, capturedAt: '2026-10-27T00:00:00.000Z',
    resource: { kind: 'document' as const, mode: 'preview' as const, reference: { workspaceId: 'ws', path: '/repo/a.md', kind: 'file' as const } },
    version: { kind: 'content' as const, resourceId: hash, contentVersion: hash }, excerpt: 'selected', selection: { kind: 'discussion' as const } };
  session.edit({ text: 'question', resourceFeedback: [feedback] }); await session.flush(); assert.equal(f.calls.length, 0);
  f.lose(); await session.send(); const input = session.getSnapshot().pending[0]!;
  assert.deepEqual(input.resourceFeedback, [feedback]); assert.equal(session.getSnapshot().draft.resourceFeedback, undefined);
  session.edit({ text: 'new question', resourceFeedback: [{ ...feedback, id: 'selection-b' }] });
  await session.retry(input.inputId);
  assert.equal(f.calls[1]!.inputId, input.inputId); assert.equal(f.calls[1]!.resourceFeedback![0]!.id, 'selection-a');
  assert.equal(session.getSnapshot().draft.resourceFeedback![0]!.id, 'selection-b');
});

test('staging an image attachment on the draft then sending submits the bytes without needing message text', async () => {
  const f = fixture(), session = f.make(); await session.load();
  const image: ProjectInputAttachment = { id: 'image-abc', name: 'shot.png', mimeType: 'image/png', size: 70,
    sourceKind: 'user_upload', kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(4)}` };
  // This is the exact order ProjectApp uses: draft first, then a text-less send.
  // Passing text here instead would trip INPUT_CHANGED against the edited draft.
  session.edit({ text: '', attachments: [image] }); await session.flush();
  const result = await session.send();
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.attachments, [image]);
  assert.equal(f.calls[0]!.text, '');
  assert.deepEqual(session.getSnapshot().draft.attachments, []);
});

test('large multi-image draft uploads chunk sequentially across CAS revisions without dropping images', async () => {
  const f = fixture(), session = f.make(); await session.load();
  const payload = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`;
  const images: ProjectInputAttachment[] = [0, 1, 2].map(index => ({
    id: `img-big-${index}`,
    name: `shot-${index}.png`,
    mimeType: 'image/png',
    size: 6_750_000,
    sourceKind: 'user_upload',
    kind: 'image',
    dataUrl: payload,
  }));
  session.edit({ text: 'three large images', attachments: images });
  const flushed = await session.flush();
  assert.equal(flushed, true);
  // Each 9 MiB image cannot share a 16 MiB chunk with two others, so revision advances >= 2 times.
  assert.ok(session.getSnapshot().revision >= 3);
  const result = await session.send();
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.attachments.length, 3);
});

test('option click rejected with QUESTION_CLOSED is dismissed cleanly without leaving an unconfirmed bubble or touching unrelated draft', async () => {
  const f = fixture();
  f.port.submit = async input => {
    f.calls.push(input);
    return { ok: false, code: 'QUESTION_CLOSED' };
  };
  const session = f.make(); await session.load();
  session.edit({ text: 'unrelated draft' }); await session.flush();
  const result = await session.send({ text: 'Option A', answerTo: 'card:question:reply:q-1', useDraft: false });
  await session.flush();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUESTION_CLOSED');
  assert.equal(session.getSnapshot().pending.length, 0);
  assert.equal(session.getSnapshot().received.length, 0);
  assert.equal(f.stored().pending.length, 0);
  assert.equal(session.getSnapshot().draft.text, 'unrelated draft');
});

test('repeat option click after durable receipt returns QUESTION_CLOSED immediately without allocating a duplicate pending input', async () => {
  const f = fixture(), session = f.make(); await session.load();
  const first = await session.send({ text: 'Option A', answerTo: 'card:question:reply:q-2', useDraft: false });
  assert.equal(first.ok, true);
  assert.equal(session.getSnapshot().received.length, 1);

  const second = await session.send({ text: 'Option A', answerTo: 'card:question:reply:q-2', useDraft: false });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'QUESTION_CLOSED');
  assert.equal(f.calls.length, 1);
  assert.equal(session.getSnapshot().pending.length, 0);
  assert.equal(f.stored().pending.length, 0);
});

test('freeform composer send rejected with QUESTION_CLOSED preserves the user draft instead of losing text', async () => {
  const f = fixture();
  f.port.submit = async input => {
    f.calls.push(input);
    if (input.answerTo) return { ok: false, code: 'QUESTION_CLOSED' };
    return f.received(input);
  };
  const session = f.make(); await session.load();
  session.edit({ text: 'Long custom reply', quote: { messageId: 'm-1', text: 'quoted' } });
  const r1 = await session.send({ quoteRefs: ['m-1'], answerTo: 'card:question:reply:q-3' });
  await session.flush();
  assert.equal(r1.code, 'QUESTION_CLOSED');
  assert.equal(session.getSnapshot().pending.length, 0);
  assert.equal(session.getSnapshot().draft.text, 'Long custom reply');
  assert.equal(session.getSnapshot().draft.quote?.messageId, 'm-1');

  // If the user started typing a newer draft before QUESTION_CLOSED returned, keep the prior composed
  // input in pending with answerTo stripped so retry delivers it cleanly without overwriting the new draft.
  const gate = f.defer();
  f.port.submit = async input => {
    f.calls.push(input);
    if (input.answerTo) return gate.promise;
    return f.received(input);
  };
  const sending = session.send({ answerTo: 'card:question:reply:q-4' });
  const firstInputId = session.getSnapshot().pending[0]!.inputId;
  session.edit({ text: 'Newer draft' });
  gate.resolve({ ok: false, code: 'QUESTION_CLOSED' });
  const r2 = await sending;
  await session.flush();
  assert.equal(r2.code, 'QUESTION_CLOSED');
  assert.equal(session.getSnapshot().draft.text, 'Newer draft');
  assert.equal(session.getSnapshot().pending.length, 1);
  assert.equal(session.getSnapshot().pending[0]!.inputId, firstInputId);
  assert.equal(session.getSnapshot().pending[0]!.answerTo, undefined);
  const retried = await session.retry(firstInputId);
  assert.equal(retried.ok, true);
  assert.equal(session.getSnapshot().pending.length, 0);
});

test('observeReceived heals pre-existing stuck duplicate reply answers and preserves non-duplicate unknown inputs', async () => {
  const f = fixture(), first = f.make(); await first.load();
  f.lose();
  await first.send({ text: 'Option A', answerTo: 'card:question:reply:q-legacy', useDraft: false });
  first.edit({ text: 'Custom unsent note' });
  await first.send({ answerTo: 'card:question:reply:q-legacy' });
  await first.flush();
  assert.equal(f.stored().pending.length, 2);

  const reopened = f.make(); await reopened.load();
  reopened.observeReceived(
    ['different-committed-input-id'],
    [{ answerTo: 'card:question:reply:q-legacy', text: 'Option A' }],
  );
  await reopened.flush();
  assert.deepEqual(reopened.getSnapshot().pending.map(item => item.text), ['Custom unsent note']);
  assert.deepEqual(f.stored().pending.map(item => item.text), ['Custom unsent note']);
});
