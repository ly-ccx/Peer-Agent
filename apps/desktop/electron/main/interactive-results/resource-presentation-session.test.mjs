import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore, createInteractiveStateStore } from '@peer-agent/runtime-node/interactive-results';
import { createDesktopInteractiveApplication } from './application-service.mjs';
import { createResourcePresentationSession } from '../../../renderer/src/workbench/interactive/resourcePresentationSession.ts';
const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
const legacy = { order: ['document:old'], recent: [JSON.stringify({ kind: 'document', path: '/repo/old.md' })] };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
    const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-layout-session-')));
    const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true }), states = createInteractiveStateStore({ resultStore: results });
    let conversationId = owner.conversationId;
    const sender = new EventEmitter();
    const runtime = { resultStore: results, stateStore: states };
    const host = createDesktopInteractiveApplication({ getRole: (actual) => actual === sender ? 'main' : null, getOwner: () => ({ conversationId }), getNativeBinding: () => null, getRuntime: () => runtime });
    const references = [];
    for (const name of ['a', 'b']) {
        const draft = { publication: { kind: 'create' }, title: `Trial ${name}`, textFallback: 'Unverified trial.', program: 'root=Text("Fixed trial")', inputs: [] };
        const receipt = results.commitPublication({ owner, source: { conversationId: 'worker', planId: 'plan', sessionId: 'session', executionEpoch: 'epoch', toolCallId: `publish-${name}` },
            draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { granted: true, grantId: `grant-${name}`, toolCallId: `publish-${name}` } }, () => true);
        results.markIndexed(receipt.callRef, receipt.indexEntry);
        references.push(receipt.reference);
    }
    const api = { readLayout: async (request) => host.readLayout(sender, request), writeLayout: async (request) => host.writeLayout(sender, request) };
    let next = 0;
    const sessions = [];
    const create = (ports = {}) => {
        const session = createResourcePresentationSession({ owner, api, legacy, createId: () => `tab-${++next}`, ...ports });
        sessions.push(session);
        return session;
    };
    t.after(() => { for (const session of sessions)
        session.dispose(); host.dispose(); states.close(); results.close(); rmSync(rootDir, { recursive: true, force: true }); });
    return { api, create, references, results, setOwner: (value) => { conversationId = value; } };
}
test('ordinary file layout stays dormant; a result opens once and persists only its fixed domain reference and reading hint', async (t) => {
    const f = await fixture(t), session = f.create();
    assert.equal(await session.load(), true);
    assert.equal(session.snapshot().protected, false);
    assert.equal(await session.flush(), true);
    assert.equal((await f.api.readLayout({ owner })).ok, true);
    assert.equal(f.results.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM presentation').get().n, 0);
    assert.equal(session.open(f.references[0], 'Trial a'), true);
    assert.equal(session.open(f.references[0], 'duplicate hint'), true);
    assert.equal(session.snapshot().layout.interactive.tabs.length, 1);
    assert.equal(session.snapshot().protected, true);
    assert.equal(session.remember(f.references[0], { top: 320, left: 0 }), true);
    assert.equal(await session.flush(), true);
    const stored = await f.api.readLayout({ owner });
    assert.ok(stored.ok && stored.snapshot);
    assert.equal(stored.snapshot.interactive.tabs[0].navigation?.top, 320);
    assert.equal(stored.snapshot.interactive.tabs[0].reference.contentVersion, f.references[0].contentVersion);
    assert.equal(JSON.stringify(stored.snapshot).includes('writer'), false);
    assert.equal(JSON.stringify(stored.snapshot).includes('inputDrafts'), false);
    assert.deepEqual(stored.snapshot.order.slice(0, 1), legacy.order);
});
test('the last tab can be closed locally and the layout can only be discarded after rechecking the exact owner', async t => {
    const f = await fixture(t), session = f.create();
    assert.equal(await session.load(), true);
    assert.equal(session.open(f.references[0]), true);
    assert.equal(await session.flush(), true);
    const saved = await f.api.readLayout({ owner });
    assert.equal(session.close(f.references[0]), true);
    f.setOwner('replacement');
    assert.equal(await session.flush(), false);
    assert.equal(session.snapshot().error, 'interactive_owner_replaced');
    const local = session.snapshot().layout;
    f.setOwner(owner.conversationId);
    assert.equal(await session.abandonReplacedOwner(), false);
    assert.deepEqual(session.snapshot().layout, local);
    assert.equal(session.snapshot().dirty, true);
    f.setOwner('');
    assert.equal(await session.abandonReplacedOwner(), false);
    assert.deepEqual(session.snapshot().layout, local);
    f.setOwner('replacement');
    assert.equal(await session.abandonReplacedOwner(), true);
    assert.equal(session.snapshot().phase, 'closed');
    assert.deepEqual(await f.api.readLayout({ owner: { ...owner, conversationId: 'replacement' } }), { ok: true, snapshot: null });
    f.setOwner(owner.conversationId);
    assert.deepEqual(await f.api.readLayout({ owner }), saved);
});
test('a late initial read rebases opens and reading by fixed reference without losing existing tabs or stealing the current intent', async (t) => {
    const f = await fixture(t);
    const seeded = await f.api.writeLayout({ owner, expectedRevision: 0, order: ['document:old', 'interactive:old-a', 'interactive:old-b'], recent: legacy.recent,
        interactive: { tabs: [{ id: 'old-a', reference: f.references[0], title: 'Trial a' }, { id: 'old-b', reference: f.references[1], title: 'Trial b' }], activeTabId: 'old-b' } });
    assert.equal(seeded.ok, true);
    const gate = deferred(), started = deferred();
    const api = { ...f.api, readLayout: async () => { const reply = await f.api.readLayout({ owner }); started.resolve(); await gate.promise; return reply; } };
    const session = f.create({ api }), loading = session.load();
    await started.promise;
    session.open(f.references[0]);
    session.remember(f.references[0], { top: 333, left: 0 });
    session.presentation(['browser:new', ...session.snapshot().layout.order], legacy.recent);
    gate.resolve();
    assert.equal(await loading, true);
    assert.equal(session.snapshot().layout.interactive.tabs.length, 2);
    assert.equal(session.snapshot().layout.interactive.activeTabId, 'old-a');
    assert.equal(session.snapshot().layout.interactive.tabs[0].navigation?.top, 333);
    assert.equal(session.snapshot().layout.order.includes('browser:new'), true);
    assert.equal(await session.flush(), true);
});
test('lost write confirmation queries the real row before saving later edits and never duplicates the committed revision', async (t) => {
    const f = await fixture(t), writes = [];
    let lose = true;
    const api = { ...f.api, writeLayout: async (request) => {
            writes.push(structuredClone(request));
            const reply = await f.api.writeLayout(request);
            if (lose) {
                lose = false;
                throw Error('ack lost');
            }
            return reply;
        } };
    const session = f.create({ api });
    await session.load();
    session.open(f.references[0]);
    assert.equal(await session.flush(), false);
    assert.equal(session.snapshot().confirmed, null);
    session.remember(f.references[0], { top: 450, left: 0 });
    assert.equal(await session.flush(), true);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].expectedRevision, 0);
    assert.equal(writes[1].expectedRevision, 1);
    assert.equal(session.snapshot().confirmed?.revision, 2);
    assert.equal(session.snapshot().confirmed?.interactive.tabs[0].navigation?.top, 450);
});
test('conflicting windows preserve both candidates until an explicit local/remote choice; no result content is replaced', async (t) => {
    const f = await fixture(t), a = f.create(), b = f.create();
    await Promise.all([a.load(), b.load()]);
    a.open(f.references[0]);
    b.open(f.references[1]);
    assert.equal(await a.flush(), true);
    assert.equal(await b.flush(), false);
    assert.equal(b.snapshot().phase, 'conflict');
    assert.deepEqual(b.snapshot().remote?.interactive.tabs[0].reference, f.references[0]);
    assert.deepEqual(b.snapshot().layout.interactive.tabs[0].reference, f.references[1]);
    assert.equal(await b.flush(), false);
    assert.equal(await b.keepLocal(), true);
    assert.equal(b.snapshot().confirmed?.revision, 2);
    a.remember(f.references[0], { top: 800, left: 0 });
    assert.equal(await a.flush(), false);
    assert.equal(await a.useRemote(), true);
    assert.deepEqual(a.snapshot().layout.interactive.tabs[0].reference, f.references[1]);
    assert.equal(f.results.getVersion(f.references[0]).content.title, 'Trial a');
    assert.equal(f.results.getVersion(f.references[1]).content.title, 'Trial b');
});
test('owner changes and corrupt/future rows cannot be saved as a new empty layout', async (t) => {
    const f = await fixture(t), saved = f.create();
    await saved.load();
    saved.open(f.references[0]);
    await saved.flush();
    f.setOwner('new-parent');
    const stale = f.create();
    stale.open(f.references[1]);
    assert.equal(await stale.load(), false);
    assert.equal(await stale.keepLocal(), false);
    assert.equal(stale.snapshot().error, 'interactive_owner_replaced');
    f.setOwner(owner.conversationId);
    const db = f.results.storage.connect(owner.workspaceId, true).db;
    db.prepare("UPDATE presentation SET body=? WHERE category='mixed-resource-layout'").run('{"formatVersion":999}');
    const corrupt = f.create();
    corrupt.open(f.references[1]);
    assert.equal(await corrupt.load(), false);
    assert.equal(await corrupt.flush(), false);
    assert.equal(await corrupt.keepLocal(), false);
    assert.equal(db.prepare("SELECT body FROM presentation WHERE category='mixed-resource-layout'").get().body, '{"formatVersion":999}');
});
test('a malformed success receipt stays unconfirmed; a later actual-row read recovers it without another write', async (t) => {
    const f = await fixture(t);
    let writes = 0;
    const api = { ...f.api, writeLayout: async (request) => {
            writes++;
            const reply = await f.api.writeLayout(request);
            if (!reply.ok)
                return reply;
            return { ...reply, snapshot: { ...reply.snapshot, revision: reply.snapshot.revision + 1 } };
        } };
    const session = f.create({ api });
    await session.load();
    session.open(f.references[0]);
    assert.equal(await session.flush(), false);
    assert.equal(session.snapshot().error, 'resource_layout_receipt_invalid');
    assert.equal(await session.flush(), true);
    assert.equal(writes, 1);
    assert.equal(session.snapshot().confirmed?.revision, 1);
});
test('disposed or timed-out reads cannot revive a session, erase an opening intent or create a domain record', async (t) => {
    const f = await fixture(t), gate = deferred();
    const session = f.create({ api: { ...f.api, readLayout: () => gate.promise }, timeoutMs: 20 });
    session.open(f.references[0]);
    assert.equal(await session.load(), false);
    assert.equal(session.snapshot().error, 'resource_layout_timeout');
    assert.equal(session.snapshot().layout.interactive.tabs.length, 1);
    session.dispose();
    gate.resolve({ ok: true, snapshot: null });
    await Promise.resolve();
    assert.equal(session.snapshot().phase, 'closed');
    assert.equal(await session.flush(), false);
    assert.equal(f.results.storage.connect(owner.workspaceId).db.prepare('SELECT COUNT(*) AS n FROM presentation').get().n, 0);
});

test('closing and reopening preserves the fixed version and last reading hint without reopening a parked tab', async t => {
    const f = await fixture(t), session = f.create(); await session.load();
    session.open(f.references[0]); const id = session.snapshot().layout.interactive.activeTabId;
    session.remember(f.references[0], { top: 733, left: 8 });
    session.close(f.references[0]);
    assert.equal(session.snapshot().layout.order.includes(`interactive:${id}`), false);
    assert.equal(session.snapshot().layout.interactive.activeTabId, null);
    assert.equal(session.activate(f.references[0]), false);
    assert.equal(await session.flush(), true);
    const restored = f.create(); await restored.load();
    assert.equal(restored.snapshot().layout.interactive.activeTabId, null);
    assert.equal(restored.open(f.references[0]), true);
    assert.equal(restored.snapshot().layout.interactive.activeTabId, id);
    assert.equal(restored.snapshot().layout.interactive.tabs.length, 1);
    assert.deepEqual(restored.snapshot().layout.interactive.tabs[0].navigation, { top: 733, left: 8 });
    assert.equal(f.results.getVersion(f.references[0]).content.title, 'Trial a');
});

test('a full reference cache evicts only closed presentation hints and preserves all open fixed references', async t => {
    const f = await fixture(t), session = f.create(); await session.load();
    const refs = Array.from({ length: 33 }, (_, index) => ({ ...f.references[0], resultId: `result-${index}` }));
    for (const ref of refs.slice(0, 32)) assert.equal(session.open(ref), true);
    assert.equal(session.open(refs[32]), false);
    const first = session.snapshot().layout.interactive.tabs[0];
    assert.equal(session.close(first.reference), true);
    assert.equal(session.open(refs[32]), true);
    assert.equal(session.snapshot().layout.interactive.tabs.length, 32);
    assert.equal(session.snapshot().layout.interactive.tabs.some(tab => tab.id === first.id), false);
    assert.equal(session.snapshot().layout.order.filter(key => key.startsWith('interactive:')).length, 32);
    assert.equal(await session.flush(), true);
    assert.equal(f.results.getVersion(f.references[0]).content.title, 'Trial a');
});
