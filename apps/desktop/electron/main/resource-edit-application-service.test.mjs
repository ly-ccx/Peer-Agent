import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { RESOURCE_FILE_REPLACE_PROVIDER } from '@peer-agent/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createResourceEditStorage } from '../../../../packages/runtime-node/src/project-agent/resource-edit-storage.mjs';
import { createResourceEditApplicationService } from './resource-edit-application-service.mjs';
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const observed = { resourceId: hash('identity'), contentVersion: hash('base') };
const target = { recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/fixture/a.md' }, base: observed };
const source = { kind: 'document', reference: target.reference, observed };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-edit-host-')), storage = createResourceEditStorage({ rootDir });
  const main = new EventEmitter(), other = new EventEmitter(), native = new EventEmitter(); main.id = 1; other.id = 2; native.id = 3;
  for (const sender of [main, other, native]) sender.isDestroyed = () => false;
  const roles = new Map([[main, 'main'], [other, 'main'], [native, 'resource']]), timers = new Map(), notices = [], reads = []; let id = 0, owner = 'main', current = true;
  let readable = async () => current;
  let reader = async (_sender, src) => ({ ok: true, target, content: 'base' });
  const service = createResourceEditApplicationService({ storage, getRole: sender => roles.get(sender), getOwner: workspaceId => workspaceId === 'bot' ? { conversationId: owner } : null,
    isSourceCurrent: () => current, readSource: async (...args) => { reads.push(args); return reader(...args); }, canReadRetained: (...args) => readable(...args),
    getWindowId: sender => `window-${sender.id}`, createId: () => `id-${++id}`, notify: (sender, notice) => notices.push({ sender, notice }),
    schedule: (callback, ms) => { const handle = Symbol(); timers.set(handle, { callback, ms }); return handle; }, cancel: handle => timers.delete(handle) });
  t.after(() => { service.dispose(); storage.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { service, storage, main, other, native, notices, timers, reads, roles, open: (requestId = 'open', sender = main) => service.open(sender, { requestId, source }),
    reader: fn => { reader = fn; }, readable: fn => { readable = fn; }, replaceOwner: () => { owner = 'replacement'; }, expire: () => { current = false; } };
}
test('actual host read creates the draft; same request reuses one view and foreign handles cannot acquire/save/close it', async t => {
  const f = fixture(t), [a, b] = await Promise.all([f.open(), f.open()]);
  assert.equal(a.ok, true); assert.deepEqual(a.handle, b.handle); assert.equal(f.reads.length, 1); assert.equal(f.storage.inspect('bot').manifest.drafts.length, 1);
  assert.equal((await f.service.acquire(f.other, { handle: a.handle })).code, 'RESOURCE_EDIT_VIEW_EXPIRED');
  assert.equal(f.service.close(f.other, a.handle).ok, false);
  const writer = await f.service.acquire(f.main, { handle: a.handle }); assert.equal(writer.ok, true);
  const late = await f.service.save(f.main, { handle: { ...a.handle, generation: 99 }, writer: writer.writer, revision: 0, text: 'late' }); assert.equal(late.ok, false);
  const changed = await f.service.save(f.main, { handle: a.handle, writer: { ...writer.writer, token: 'forged' }, revision: 0, text: 'forged' }); assert.equal(changed.code, 'RESOURCE_EDIT_STALE_WRITER');
  assert.equal(typeof f.service.start, 'undefined'); assert.equal(typeof f.service.settle, 'undefined');
});
test('submission binding pins the saved revision on the view queue, rejects foreign/stale writers, and survives only page close', async t => {
  const f = fixture(t), a = await f.open(), acquired = await f.service.acquire(f.main, { handle: a.handle });
  const request = { handle: a.handle, writer: acquired.writer, revision: 0, requestId: 'submission' }; let binding;
  const reserve = value => { binding = value.binding; const result = f.storage.apply('bot', { type: 'reserve', requestId: request.requestId, draftId: value.draft.id, revision: value.draft.revision,
    writer: value.writer, providerId: RESOURCE_FILE_REPLACE_PROVIDER, proposedVersion: hash(value.draft.text) }); return { ...result, binding, fresh: result.changed }; };
  assert.equal((await f.service.withSubmissionView(f.other, request, reserve)).ok, false);
  assert.equal((await f.service.withSubmissionView(f.main, { ...request, writer: { ...acquired.writer, token: 'forged' } }, reserve)).code, 'RESOURCE_EDIT_STALE_WRITER');
  const result = await f.service.withSubmissionView(f.main, request, reserve); assert.equal(result.fresh, true);
  assert.equal(f.service.isSubmissionCurrent({ ...binding }, result.operation), false);
  await f.service.save(f.main, { handle: a.handle, writer: acquired.writer, revision: 0, text: 'later input' });
  assert.equal((await f.service.withSubmissionView(f.main, request, reserve)).fresh, false);
  assert.equal((await f.service.withSubmissionView(f.main, { ...request, revision: 1 }, reserve)).code, 'RESOURCE_EDIT_ID_CONFLICT');
  f.service.close(f.main, a.handle); assert.equal(f.service.isSubmissionCurrent(binding, result.operation), true);
  f.replaceOwner(); assert.equal(f.service.isSubmissionCurrent(binding, result.operation), false);
});
test('takeover invalidates old writer immediately; readonly close cannot release the new owner; notices contain no text/token', async t => {
  const f = fixture(t), a = await f.open('a'), b = await f.open('b', f.other), first = await f.service.acquire(f.main, { handle: a.handle });
  assert.equal((await f.service.acquire(f.other, { handle: b.handle })).code, 'RESOURCE_EDIT_WRITER_BUSY');
  const second = await f.service.acquire(f.other, { handle: b.handle, takeover: true }); assert.equal(second.ok, true);
  assert.equal((await f.service.save(f.main, { handle: a.handle, writer: first.writer, revision: 0, text: 'stale' })).code, 'RESOURCE_EDIT_STALE_WRITER');
  f.service.close(f.main, a.handle);
  assert.equal((await f.service.save(f.other, { handle: b.handle, writer: second.writer, revision: 0, text: 'new input' })).ok, true);
  assert.equal(f.storage.readDraft('bot', b.handle.draftId).draft.text, 'new input');
  assert.ok(f.notices.some(row => row.notice.writerViewId === b.handle.viewId));
  assert.equal(JSON.stringify(f.notices.map(row => row.notice)).includes(second.writer.token), false);
  assert.equal(JSON.stringify(f.notices.map(row => row.notice)).includes('new input'), false);
});
test('cancel, deadline and destroyed source retire a pending read without later creating a draft or view', async t => {
  for (const action of ['cancel', 'timeout', 'destroy']) {
    const f = fixture(t); let finish;
    f.reader(() => new Promise(resolve => { finish = resolve; })); const pending = f.open(); await tick();
    if (action === 'cancel') f.service.cancelOpen(f.main, 'open');
    if (action === 'timeout') { assert.equal([...f.timers.values()][0].ms, 30_000); [...f.timers.values()][0].callback(); }
    if (action === 'destroy') f.main.emit('destroyed');
    const result = await pending; assert.equal(result.ok, false); if (action === 'timeout') assert.equal(result.code, 'RESOURCE_EDIT_OPEN_TIMEOUT');
    finish({ ok: true, target, content: 'base' }); await tick(); assert.equal(f.storage.inspect('bot').manifest.drafts.length, 0);
  }
});
test('owner or source change while awaiting read cannot silently create a draft for a new Bot or use a new file version', async t => {
  const f = fixture(t); f.reader(async () => { f.replaceOwner(); return { ok: true, target, content: 'base' }; });
  assert.equal((await f.open()).ok, false); assert.equal(f.storage.inspect('bot').manifest.drafts.length, 0);
  const g = fixture(t); g.reader(async () => ({ ok: true, target: { ...target, base: { ...observed, contentVersion: hash('new') } }, content: 'new' }));
  assert.equal((await g.open()).code, 'RESOURCE_EDIT_VERSION_CHANGED'); assert.equal(g.storage.inspect('bot').manifest.drafts.length, 0);
});
test('saved user intent recovers after closing a view without sending or reading the original file again; changed recipient is refused', async t => {
  const f = fixture(t), a = await f.open(), acquired = await f.service.acquire(f.main, { handle: a.handle });
  await f.service.save(f.main, { handle: a.handle, writer: acquired.writer, revision: 0, text: 'saved draft' }); f.service.close(f.main, a.handle);
  f.reader(() => { throw Error('original source is offline'); });
  const restored = await f.service.resume(f.main, { requestId: 'recover', workspaceId: 'bot', draftId: a.handle.draftId });
  assert.equal(restored.ok, true); assert.equal(restored.draft.text, 'saved draft'); assert.equal(f.reads.length, 1);
  f.replaceOwner(); assert.equal((await f.service.resume(f.main, { requestId: 'wrong-owner', workspaceId: 'bot', draftId: a.handle.draftId })).code, 'RESOURCE_EDIT_RECIPIENT_CHANGED');
  assert.equal((await f.service.list(f.main, { workspaceId: 'bot' })).staleCount, 1);
});
test('native context requires a real source descriptor and cannot resume another resource; malformed body/recipient/identity fields do not enter storage', async t => {
  const f = fixture(t), nativeSource = { kind: 'native', identity: { viewId: 'native', windowId: 'native-window', generation: 1 }, path: '/fixture/a.md', observed };
  const opened = await f.service.open(f.native, { requestId: 'native-open', source: nativeSource }); assert.equal(opened.ok, true);
  assert.equal((await f.service.resume(f.native, { requestId: 'no-lease', workspaceId: 'bot', draftId: opened.handle.draftId })).ok, false);
  f.reader(async () => ({ ok: true, target: { ...target, base: { ...observed, resourceId: hash('other-file') } }, content: 'base' }));
  assert.equal((await f.service.resume(f.native, { requestId: 'wrong-file', workspaceId: 'bot', draftId: opened.handle.draftId, source: { ...nativeSource, observed: { ...observed, resourceId: hash('other-file') } } })).code, 'RESOURCE_EDIT_SOURCE_CHANGED');
  assert.equal((await f.service.open(f.main, { requestId: 'bad-body', source, baseText: 'injected' })).ok, false);
  assert.equal((await f.service.open(f.main, { requestId: 'bad-source', source: { ...source, recipient: { workspaceId: 'other' } } })).ok, false);
});
test('save receipts describe exact persisted text without echoing full body or baseline; expired lease cannot produce a saved receipt', async t => {
  const f = fixture(t), a = await f.open(), writer = await f.service.acquire(f.main, { handle: a.handle });
  const receipt = await f.service.save(f.main, { handle: a.handle, writer: writer.writer, revision: 0, text: 'exact user text' });
  assert.equal(receipt.ok, true); assert.equal(receipt.saved.textVersion, hash('exact user text')); assert.equal(receipt.saved.revision, 1); assert.equal('draft' in receipt, false);
  f.expire(); assert.equal((await f.service.save(f.main, { handle: a.handle, writer: writer.writer, revision: 1, text: 'must stay local' })).ok, false);
  assert.equal(f.storage.readDraft('bot', a.handle.draftId).draft.text, 'exact user text');
});
test('snapshot metadata is filtered by current source scope and body is not hydrated when scope/owner changed during permission recheck', async t => {
  const f = fixture(t), opened = await f.open(), acquired = await f.service.acquire(f.main, { handle: opened.handle });
  const reserved = f.storage.apply('bot', { type: 'reserve', requestId: 'actual-operation', draftId: opened.handle.draftId, revision: 0, writer: acquired.writer, providerId: 'fixture.file', proposedVersion: hash('base') });
  f.storage.apply('bot', { type: 'start', requestId: 'actual-operation', payloadHash: reserved.operation.payloadHash });
  f.storage.apply('bot', { type: 'settle', requestId: 'actual-operation', receipt: { outcome: 'applied', observedVersion: hash('base'), toolCallId: 'fixture-call', evidenceRef: 'evidence://fixture' } });
  const history = await f.service.history(f.main, { workspaceId: 'bot' }); assert.equal(history.items.length, 2);
  let bodyReads = 0; const read = f.storage.readSnapshot; f.storage.readSnapshot = (...args) => { bodyReads++; return read(...args); };
  f.readable(async () => false); assert.equal((await f.service.readSnapshot(f.main, { workspaceId: 'bot', id: history.items[0].id })).code, 'RESOURCE_EDIT_SCOPE_DENIED'); assert.equal(bodyReads, 0);
  const filtered = await f.service.history(f.main, { workspaceId: 'bot' }); assert.equal(filtered.items.length, 0); assert.equal(filtered.unavailableCount, 2);
  f.readable(async () => { f.replaceOwner(); return true; }); assert.equal((await f.service.readSnapshot(f.main, { workspaceId: 'bot', id: history.items[0].id })).code, 'RESOURCE_EDIT_SOURCE_CHANGED'); assert.equal(bodyReads, 0);
});

test('same-view read is a barrier after queued saves, so unknown-save reconciliation cannot read an older revision', async t => {
  const f = fixture(t), opened = await f.open(), acquired = await f.service.acquire(f.main, { handle: opened.handle });
  const saving = f.service.save(f.main, { handle: opened.handle, writer: acquired.writer, revision: 0, text: 'already queued' });
  const reading = f.service.read(f.main, opened.handle);
  const [saved, read] = await Promise.all([saving, reading]);
  assert.equal(saved.ok, true); assert.equal(read.ok, true); assert.equal(read.draft.text, 'already queued'); assert.equal(read.draft.revision, saved.saved.revision);
});
