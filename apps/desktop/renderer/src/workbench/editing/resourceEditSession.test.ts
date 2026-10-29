import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { ResourceEditsApi, ResourceEditView, ResourceEditWriter } from '@peer-agent/protocol';
import { createResourceEditSession } from './resourceEditSession.ts';
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const time = '2026-10-27T01:00:00.000Z';
const handle = { viewId: 'view', windowId: 'window', generation: 1, draftId: 'draft' };
const target = { recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: { workspaceId: 'bot', path: '/fixture/a.md' }, base: { resourceId: hash('resource'), contentVersion: hash('base') } };
const initial: ResourceEditView = { handle, draft: { id: 'draft', target, baseText: 'base', text: 'base', revision: 0, createdAt: time, updatedAt: time } };
const writer: ResourceEditWriter = { viewId: handle.viewId, windowId: handle.windowId, generation: handle.generation, token: 'writer', lease: 1 };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(withInitial = true) {
  let view = structuredClone(initial), id = 0;
  const saves: Parameters<ResourceEditsApi['save']>[0][] = [], closed: unknown[] = [], cancelled: string[] = [], timers = new Map<number, () => void>();
  const unsupported = async (): Promise<never> => { throw Error('Unexpected API in local edit-session fixture'); };
  const api: ResourceEditsApi = {
    onChanged: () => () => {}, open: unsupported, discard: unsupported, list: unsupported, history: unsupported,
    readSnapshot: unsupported, cleanup: unsupported, archive: unsupported, clearDelivery: unsupported, submit: unsupported,
    continueSubmission: unsupported, operationStatus: unsupported, reconcileSubmission: unsupported, cancelSubmission: unsupported,
    decideSubmissionPermission: unsupported, readExecution: unsupported, readSubmission: unsupported,
    resume: async () => ({ ok: true, ...structuredClone(view) }),
    read: async () => ({ ok: true, ...structuredClone(view) }),
    acquire: async () => ({ ok: true, ...structuredClone(view), writer }),
    save: async (request: Parameters<ResourceEditsApi['save']>[0]) => { saves.push(request); view = { ...view, draft: { ...view.draft, text: request.text, revision: view.draft.revision + 1 } }; return { ok: true, saved: { draftId: 'draft', revision: view.draft.revision, updatedAt: time, textVersion: hash(request.text) } }; },
    close: async (value: unknown) => { closed.push(value); return { ok: true }; },
    cancelOpen: async (value: string) => { cancelled.push(value); return { ok: true }; },
  };
  const session = createResourceEditSession({ api, workspaceId: 'bot', draftId: 'draft', ...(withInitial ? { initial: view } : {}), expectedPath: '/fixture/a.md', hashText: async text => hash(text), createId: () => `request-${++id}`,
    schedule: callback => { const key = ++id; timers.set(key, callback); return key as unknown as ReturnType<typeof setTimeout>; }, cancel: timer => { timers.delete(timer as unknown as number); } });
  return { api: api as { -readonly [K in keyof ResourceEditsApi]: ResourceEditsApi[K] }, session, saves, closed, cancelled, timers,
    current: () => view, change: (text: string) => { view = { ...view, draft: { ...view.draft, text, revision: view.draft.revision + 1 } }; } };
}
test('late save receipt never replaces newer input; one flush drains each revision serially', async () => {
  const f = fixture(); await f.session.claim(); const first = deferred<Awaited<ReturnType<ResourceEditsApi['save']>>>(), save = f.api.save;
  let calls = 0; f.api.save = async request => { if (++calls === 1) { await first.promise; } return save(request); };
  f.session.edit('first'); const flush = f.session.flush(); await tick(); f.session.edit('second');
  first.resolve({ ok: false, code: 'unused' }); assert.equal(await flush, true);
  assert.deepEqual(f.saves.map(save => [save.revision, save.text]), [[0, 'first'], [1, 'second']]);
  assert.equal(f.session.snapshot().text, 'second'); assert.equal(f.session.snapshot().savedText, 'second'); assert.equal(f.session.snapshot().dirty, false);
});
test('save that committed but lost its acknowledgement is reconciled by read without replay', async () => {
  const f = fixture(); await f.session.claim(); const save = f.api.save;
  f.api.save = async request => { await save(request); throw Error('ack lost'); };
  f.session.edit('durable'); assert.equal(await f.session.flush(), true); assert.equal(f.saves.length, 1); assert.equal(f.session.snapshot().dirty, false);
});
test('unconfirmed save that did not commit retains local text and stops automatic retry', async () => {
  const f = fixture(); await f.session.claim(); let calls = 0;
  f.api.save = async () => { calls++; throw Error('offline'); };
  f.session.edit('keep me'); assert.equal(await f.session.flush(), false); await tick();
  assert.equal(calls, 1); assert.equal(f.session.snapshot().text, 'keep me'); assert.equal(f.session.snapshot().dirty, true); assert.equal(f.timers.size, 0);
});
test('IME and invalid input remain buffered; external writer notices stop autosave', async () => {
  const f = fixture(); await f.session.claim(); f.session.setComposing(true); f.session.edit('中文');
  assert.equal(await f.session.flush(), false); assert.equal(f.saves.length, 0); assert.equal(await f.session.close(), false);
  f.session.setComposing(false); f.session.receive({ workspaceId: 'bot', draftId: 'draft', kind: 'writer', writerViewId: 'another' });
  assert.equal(f.timers.size, 0); assert.equal(f.session.snapshot().writer, null); assert.equal(f.session.snapshot().text, '中文');
  await f.session.claim(true); f.session.edit('bad\u0000input'); assert.equal(await f.session.flush(), false); assert.equal(f.session.snapshot().text, 'bad\u0000input'); assert.equal(f.saves.length, 0);
});
test('takeover and reread preserve a conflicting buffer until an explicit content choice', async () => {
  const f = fixture(); await f.session.claim(); f.session.edit('mine'); f.session.receive({ workspaceId: 'bot', draftId: 'draft', kind: 'writer', writerViewId: 'another' });
  f.change('theirs'); await f.session.claim(true); assert.equal(f.session.snapshot().text, 'mine'); assert.equal(f.session.snapshot().savedText, 'theirs');
  assert.equal(f.session.snapshot().reviewRequired, true); await f.session.readSaved(); assert.equal(f.session.snapshot().reviewRequired, true);
  assert.equal(await f.session.flush(), false); assert.equal(f.saves.length, 0);
  assert.equal(await f.session.confirmBufferedSave(), true); assert.equal(f.current().draft.text, 'mine');
});
test('remount during a safety flush prevents closing the newly used view', async () => {
  const f = fixture(); await f.session.claim(); const barrier = deferred<void>(), save = f.api.save; let unused = true;
  f.api.save = async request => { await barrier.promise; return save(request); };
  f.session.edit('keep'); const closing = f.session.close(() => unused); await tick(); unused = false; barrier.resolve();
  assert.equal(await closing, false); assert.equal(f.closed.length, 0); assert.ok(f.session.snapshot().view); assert.equal(f.session.snapshot().dirty, false);
});
test('cancelled late resume closes its issued view without replacing buffered text', async () => {
  const f = fixture(false), barrier = deferred<Awaited<ReturnType<ResourceEditsApi['resume']>>>(); f.api.resume = () => barrier.promise;
  const opening = f.session.connect(); await tick(); f.session.cancelOpening(); barrier.resolve({ ok: true, ...initial });
  assert.equal(await opening, false); assert.equal(f.session.snapshot().view, null); assert.equal(f.closed.length, 1); assert.equal(f.cancelled.length, 1);
});
test('discard notice while saving cannot leave busy state stuck or clear local input', async () => {
  const f = fixture(); await f.session.claim(); const barrier = deferred<Awaited<ReturnType<ResourceEditsApi['save']>>>(); f.api.save = () => barrier.promise;
  f.session.edit('preserved'); const saving = f.session.flush(); await tick(); f.session.receive({ workspaceId: 'bot', draftId: 'draft', kind: 'discarded' });
  barrier.resolve({ ok: false, code: 'RESOURCE_EDIT_DRAFT_MISSING' }); await saving;
  assert.equal(f.session.snapshot().saving, false); assert.equal(f.session.snapshot().text, 'preserved'); assert.equal(f.session.snapshot().dirty, true);
});

test('a completed delete cannot erase input typed after its request', async () => {
  const f = fixture(); await f.session.claim(); const barrier = deferred<Awaited<ReturnType<ResourceEditsApi['discard']>>>(); f.api.discard = () => barrier.promise;
  const deleting = f.session.discard(); await tick(); f.session.edit('later input'); barrier.resolve({ ok: true }); await deleting;
  assert.equal(f.session.snapshot().text, 'later input'); assert.equal(f.session.snapshot().dirty, true); assert.equal(f.session.snapshot().view, null);
});

test('writer receipts for a different view cannot unlock the buffer', async () => {
  const f = fixture(); f.api.acquire = async () => ({ ok: true, ...initial, writer: { ...writer, viewId: 'different-view' } });
  assert.equal(await f.session.claim(), false); assert.equal(f.session.snapshot().writer, null); assert.equal(f.session.snapshot().error, 'RESOURCE_EDIT_SOURCE_CHANGED');
});

test('source cursor and separate preview/comparison positions survive closing and reconnecting a saved draft', async () => {
  const f = fixture(); f.session.remember({ start: 2, end: 3, top: 90, left: 7 }); f.session.rememberReading('preview', { top: 180, left: 0 }); f.session.rememberReading('compare', { top: 500, left: 25 });
  await f.session.close(); await f.session.connect();
  assert.deepEqual(f.session.snapshot().cursor, { start: 2, end: 3, top: 90, left: 7 });
  assert.deepEqual(f.session.snapshot().reading, { preview: { top: 180, left: 0 }, compare: { top: 500, left: 25 } });
});
