import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore } from './store.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveRuntime } from './runtime.mjs';
import { createInteractiveRetention, INTERACTIVE_RETENTION_SOURCES } from './retention.mjs';
import { encode, jsonDigest } from './storage.mjs';
import { createInteractiveResultStore as createLegacyStore } from './test-fixtures/retention-legacy-store.mjs';
import { createInteractivePresentationStore as createLegacyPresentation } from './test-fixtures/retention-legacy-presentation.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' }, current = () => true;
const identity = { viewId: 'view-a', windowId: 'window-a', generation: 'view-generation' };
const draft = { publication: { kind: 'create' }, title: 'Synthetic retained trial', textFallback: 'Unverified model trial. '.repeat(20),
  program: '$budget=100\nroot=NumberInput("budget","Budget",$budget,0,1000,1)', inputs: [] };
const now = () => '2026-11-04T00:00:00.000Z';

test('legacy writer fixtures preserve the exact pinned source bytes apart from import relocation', () => {
  const imports = {
    store: { "'../../data-store.mjs'": "'../data-store.mjs'", "'./retention-legacy-storage.mjs'": "'./storage.mjs'",
      "'../publication-attempts.mjs'": "'./publication-attempts.mjs'", "'../owner-privacy.mjs'": "'./owner-privacy.mjs'" },
    storage: { "'../../sqlite/connection.mjs'": "'../sqlite/connection.mjs'" },
    presentation: { "'./retention-legacy-storage.mjs'": "'./storage.mjs'" },
  };
  for (const [name, relocations] of Object.entries(imports)) {
    const fixture = readFileSync(new URL(`./test-fixtures/retention-legacy-${name}.mjs`, import.meta.url), 'utf8');
    assert.match(fixture.split('\n')[0], /ecb77e0dde3cc446859070c5e21fb455bda8ebf0/);
    const expected = fixture.match(/Original SHA-256: ([a-f0-9]{64})/)[1];
    let source = fixture.split('\n').slice(3).join('\n');
    for (const [adapted, original] of Object.entries(relocations)) { assert.equal(source.split(adapted).length, 2); source = source.replace(adapted, original); }
    assert.equal(createHash('sha256').update(source).digest('hex'), expected);
  }
});

async function fixture(t, storeOptions = {}) {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-retention-'))), resources = [];
  const store = createInteractiveResultStore({ rootDir, now, assertCompatibility: current, ...storeOptions });
  const states = createInteractiveStateStore({ resultStore: store, now }); resources.push(states, store);
  const content = await validateDraft(draft); let ordinal = 0, revision = 0, pins = [], followupIds = [], leased = true, releases = 0;
  const acquireRoots = () => {
    const acquiredRevision = revision;
    return { sources: Object.fromEntries(INTERACTIVE_RETENTION_SOURCES.map(source => [source, jsonDigest([source, acquiredRevision])])),
      pins, followupIds, assertCurrent: () => leased && revision === acquiredRevision, release: () => { releases++; } };
  };
  const retention = createInteractiveRetention({ resultStore: store, stateStore: states, assertOwner: candidate => leased && encode(candidate) === encode(owner), acquireRoots, now });
  function publish({ base, program, provenance = [], indexed = true, target = store } = {}) {
    const toolCallId = `publish-${++ordinal}`, source = { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', executionEpoch: 'epoch-a', toolCallId };
    const candidate = base ? { ...draft, publication: { kind: 'revise', base } } : draft;
    const prepared = program ? { ...candidate, program } : candidate;
    const validated = program ? validateDraft(prepared) : Promise.resolve(content);
    return validated.then(value => {
      const receipt = target.commitPublication({ owner, source, draft: prepared, content: value, provenance, dataLevel: 'D3_private',
        grant: { grantId: `grant-${ordinal}`, toolCallId, granted: true } }, current);
      if (indexed) target.markIndexed(receipt.callRef, receipt.indexEntry);
      return { ...receipt, source, draft: prepared };
    });
  }
  function legacy() { const value = createLegacyStore({ rootDir, now, assertCompatibility: current }); resources.push(value); return value; }
  const first = await publish();
  const db = store.storage.connect(owner.workspaceId).db;
  const counts = () => Object.fromEntries(['objects', 'versions', 'operations', 'states', 'saves', 'followups'].map(table =>
    [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]));
  const clean = (reference = first.reference, requestId = 'cleanup-a') => {
    const preview = retention.preview(reference);
    return retention.cleanup({ reference, requestId, expectedDigest: preview.cleanupDigest });
  };
  t.after(() => { for (const resource of resources) resource.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, store, states, retention, first, publish, legacy, db, counts, clean, acquireRoots,
    setPins(value) { pins = value; revision++; }, setFollowups(value) { followupIds = value; revision++; }, bump() { revision++; }, revoke() { leased = false; }, releases: () => releases };
}

test('an actual read-only view in another process blocks retirement until the view closes or the process exits', { timeout: 10_000 }, async t => {
  const f = await fixture(t), reference = f.first.reference;
  const before = f.retention.preview(reference);
  const url = name => JSON.stringify(new URL(name, import.meta.url).href);
  const script = `import { EventEmitter } from 'node:events';
    import { createInteractiveResultStore } from ${url('./store.mjs')};
    import { createInteractiveStateStore } from ${url('./state-store.mjs')};
    import { createInteractiveViewService } from ${url('./view-service.mjs')};
    const [rootDir, reference] = JSON.parse(process.argv[1]);
    const resultStore = createInteractiveResultStore({ rootDir, assertCompatibility: () => true });
    const stateStore = createInteractiveStateStore({ resultStore });
    const service = createInteractiveViewService({ resultStore, stateStore, resolveSource: () => ({ owner: reference.owner, assertCurrent: () => true }) });
    const sender = new EventEmitter();
    process.on('message', async action => {
      if (action === 'close') { sender.emit('destroyed'); process.send('closed'); return; }
      const reply = await service.open(sender, { requestId: 'open-a', reference });
      process.send(reply.ok ? 'open' : reply.code);
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([f.rootDir, reference])], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const send = async action => {
    const response = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    child.send(action);
    return (await response)[0];
  };
  assert.equal(await send('open'), 'open');
  const old = createLegacyPresentation({ resultStore: f.legacy(), assertOwner: current, now });
  old.writeLayout(owner, { expectedRevision: 0, order: [], recent: [], interactive: { tabs: [], activeTabId: null } });
  assert.deepEqual(f.retention.preview(reference).blockers, [{ source: 'views', count: 1 }]);
  const row = f.db.prepare("SELECT id,body FROM presentation WHERE category='interactive-active-view'").get();
  const replace = f.db.prepare("UPDATE presentation SET body=? WHERE category='interactive-active-view' AND id=?");
  replace.run('{}', row.id);
  assert.throws(() => f.retention.preview(reference), { code: 'interactive_storage_corrupt' });
  replace.run(row.body, row.id);
  assert.throws(() => f.retention.cleanup({ reference, requestId: 'cleanup-a', expectedDigest: before.cleanupDigest }), { code: 'interactive_retention_stale' });
  assert.equal(await send('close'), 'closed');
  assert.deepEqual(f.retention.preview(reference).blockers, []);
  assert.equal(await send('open'), 'open');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  assert.deepEqual(f.retention.preview(reference).blockers, []);
  assert.equal(f.clean().versions.length, 1);
});

test('material retirement requires its own guard, protects provenance and keeps shared bytes', async t => {
  const f = await fixture(t);
  const record = { owner, source: { kind: 'tool-result', conversationId: 'worker-a', toolCallId: 'read-mat-a' },
    value: { text: 'canonical material' }, dataLevel: 'D3_private', observedAt: now(), truncated: false, redacted: false,
    evidenceRefs: ['tool-result://read-mat-a'] };
  const source = f.store.recordMaterial(record, current);
  const otherRecord = { ...record, source: { ...record.source, toolCallId: 'read-mat-b' }, evidenceRefs: ['tool-result://read-mat-b'] };
  const otherSource = f.store.recordMaterial(otherRecord, current);
  const selection = { owner, source };
  assert.throws(() => f.retention.previewMaterial(selection), { code: 'interactive_retention_unavailable' });
  let blocked = true, changed = false, releaseFailure = false;
  const retention = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current,
    acquireRoots: () => ({ ...f.acquireRoots(), materialResponsibility: () => ({
      digest: jsonDigest({ blocked }), blocked, assertCurrent: () => !changed,
      release() { if (releaseFailure) throw Error('material release failed'); },
    }) }), now,
    onStep(step) { if (step === 'material_cleanup_before_commit' && crash) throw Error('interrupted'); } });
  let crash = false;
  const live = retention.previewMaterial(selection);
  assert.deepEqual(live.blockers, ['source']);
  assert.throws(() => retention.cleanupMaterial({ ...selection, expectedDigest: live.cleanupDigest, requestId: 'retire-mat' }),
    { code: 'interactive_cleanup_blocked' });
  blocked = false;
  const provenance = [{ bindingId: 'snapshot', source, contentVersion: source.expectedContentVersion, selectedDigest: source.expectedContentVersion,
    observedAt: now(), capturedAt: now(), truncated: false, redacted: false, dataLevel: 'D3_private', evidenceRefs: record.evidenceRefs }];
  const published = await f.publish({ provenance });
  assert.deepEqual(retention.previewMaterial(selection).blockers, ['published-version']);
  f.clean(published.reference, 'clean-material-result');
  const old = f.legacy();
  assert.deepEqual(old.readMaterial(owner, source).value, record.value);
  const preview = retention.previewMaterial(selection);
  const request = { ...selection, expectedDigest: preview.cleanupDigest, requestId: 'retire-mat' };
  changed = true;
  assert.throws(() => retention.cleanupMaterial(request), { code: 'interactive_retention_stale' });
  changed = false; crash = true;
  assert.throws(() => retention.cleanupMaterial(request), /interrupted/);
  assert.deepEqual(f.store.readMaterial(owner, source).value, record.value);
  crash = false; releaseFailure = true;
  assert.throws(() => retention.cleanupMaterial(request), { code: 'interactive_cleanup_outcome_unknown' });
  const receipt = retention.readMaterialReceipt(selection);
  assert.equal(receipt.requestId, request.requestId);
  releaseFailure = false;
  assert.deepEqual(retention.readMaterialReceipt(selection), receipt);
  assert.deepEqual(retention.cleanupMaterial(request), receipt);
  assert.throws(() => retention.cleanupMaterial({ ...request, requestId: 'different' }), { code: 'interactive_cleanup_parameter_conflict' });
  assert.throws(() => f.store.readMaterial(owner, source), { code: 'material_snapshot_cleaned' });
  assert.throws(() => f.store.recordMaterial(record, current), { code: 'material_snapshot_cleaned' });
  assert.throws(() => old.readMaterial(owner, source));
  assert.throws(() => old.recordMaterial(record, current), { code: 'material_identity_conflict' });
  assert.deepEqual(f.store.readMaterial(owner, otherSource).value, record.value);
  const last = { owner, source: otherSource };
  const final = retention.previewMaterial(last);
  retention.cleanupMaterial({ ...last, expectedDigest: final.cleanupDigest, requestId: 'retire-other-mat' });
  assert.equal(f.db.prepare('SELECT 1 FROM objects WHERE hash=?').get(otherSource.expectedContentVersion), undefined);
  assert.equal(f.store.getVersion(f.first.reference).content.initialValues.$budget, 100);
});

test('isolated followup retirement keeps retry identity and requires fresh unreferenced roots', async t => {
  const f = await fixture(t), { reference } = f.first;
  const writer = f.states.acquire({ reference, identity, expectedRevision: 0 }, current);
  const state = f.states.read(reference, current);
  const input = { reference, identity, writer, stateRevision: 0, stateDigest: state.stateDigest, fields: ['$budget'], requestId: 'freeze-retire' };
  const snapshot = await f.states.prepareFollowup(input, current);
  const selection = { owner, followupId: snapshot.followupId };
  const withWriter = f.retention.previewFollowup(selection);
  assert.deepEqual(withWriter.blockers, ['writer']);
  assert.throws(() => f.retention.cleanupFollowup({ ...selection, requestId: 'clean-frozen', expectedDigest: withWriter.cleanupDigest }),
    { code: 'interactive_cleanup_blocked' });
  f.states.release({ reference, identity, writer }, current);
  f.setFollowups([snapshot.followupId]);
  const referenced = f.retention.previewFollowup(selection);
  assert.deepEqual(referenced.blockers, ['followup']);
  assert.throws(() => f.retention.cleanupFollowup({ ...selection, requestId: 'clean-frozen', expectedDigest: referenced.cleanupDigest }),
    { code: 'interactive_cleanup_blocked' });
  f.setFollowups([]);
  const eligible = f.retention.previewFollowup(selection);
  assert.deepEqual(eligible.blockers, []);
  assert.throws(() => f.retention.cleanupFollowup({ ...selection, requestId: 'clean-frozen', expectedDigest: withWriter.cleanupDigest }),
    { code: 'interactive_retention_stale' });
  const before = f.counts();
  const request = { ...selection, requestId: 'clean-frozen', expectedDigest: eligible.cleanupDigest };
  const interrupted = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current,
    acquireRoots: f.acquireRoots, now, onStep(step) { if (step === 'followup_cleanup_before_commit') throw Error('injected interruption'); } });
  assert.throws(() => interrupted.cleanupFollowup(request), /injected interruption/);
  assert.deepEqual(f.states.readFollowup(owner, snapshot.followupId), snapshot);
  const lost = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current,
    acquireRoots() {
      const held = f.acquireRoots();
      return { ...held, release() { held.release(); throw Error('roots release failed'); } };
    }, now });
  assert.throws(() => lost.cleanupFollowup(request), { code: 'interactive_cleanup_outcome_unknown' });
  const retired = lost.readFollowupReceipt(selection);
  assert.equal(retired.requestId, request.requestId);
  assert.equal(retired.followupId, snapshot.followupId);
  assert.equal(Object.hasOwn(retired, 'values'), false);
  assert.deepEqual(f.retention.readFollowupReceipt(selection), retired);
  assert.deepEqual(f.retention.cleanupFollowup(request), retired);
  assert.throws(() => f.retention.cleanupFollowup({ ...request, requestId: 'different-clean' }),
    { code: 'interactive_cleanup_parameter_conflict' });
  assert.throws(() => f.states.readFollowup(owner, snapshot.followupId), { code: 'interactive_followup_cleaned' });
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.getVersion(reference).content.initialValues.$budget, 100);
  const nextWriter = f.states.acquire({ reference, identity, expectedRevision: 0 }, current);
  await assert.rejects(f.states.prepareFollowup({ ...input, writer: nextWriter }, current), { code: 'interactive_followup_cleaned' });
});

test('retirement atomically clears every fixed version and confirmed state while retaining operations and frozen values', async t => {
  const f = await fixture(t);
  const old = f.legacy(); assert.equal(old.getVersion(f.first.reference).content.initialValues.$budget, 100);
  const writer = f.states.acquire({ reference: f.first.reference, identity, expectedRevision: 0 }, current);
  const saved = f.states.save({ reference: f.first.reference, identity, writer, expectedRevision: 0, requestId: 'save-a', values: { $budget: 150 }, inputDrafts: {} }, current);
  const frozen = await f.states.prepareFollowup({ reference: f.first.reference, identity, writer, stateRevision: saved.stateRevision,
    stateDigest: saved.stateDigest, fields: ['$budget'], requestId: 'freeze-a' }, current);
  f.states.release({ reference: f.first.reference, identity, writer }, current);
  const next = await f.publish({ base: f.first.reference, program: draft.program.replace('$budget=100', '$budget=200') });
  assert.throws(() => f.retention.preview(f.first.reference), { code: 'version_conflict' });
  const before = f.counts(), receipt = f.clean(next.reference);
  assert.equal(receipt.versions.length, 2); assert.equal(receipt.stateRowsRemoved, 1); assert.equal(receipt.saveRowsRemoved, 1);
  assert.ok(receipt.objectBytesRemoved > 0); assert.equal(receipt.versions[0].textFallback.length, 256);
  assert.equal(receipt.versions[0].truncated, true);
  assert.ok(receipt.versions.every(row => row.dataLevel === 'D3_private'));
  assert.deepEqual(new Set(receipt.versions.map(row => row.source.toolCallId)), new Set([f.first.source.toolCallId, next.source.toolCallId]));
  assert.deepEqual(f.counts(), { ...before, objects: 0, states: 0, saves: 0 });
  assert.deepEqual(f.states.readFollowup(owner, frozen.followupId), frozen);
  assert.equal(f.store.getOperation(f.first.callRef).publicationStatus, 'published');
  assert.throws(() => f.store.getVersion(next.reference), { code: 'interactive_content_cleaned' });
  assert.throws(() => old.getVersion(f.first.reference), { code: 'interactive_content_cleaned' });
  assert.throws(() => f.states.save({ reference: f.first.reference, identity, writer, expectedRevision: 1, requestId: 'late-save', values: { $budget: 160 } }, current),
    { code: 'interactive_content_cleaned' });
  assert.deepEqual(f.retention.readReceipt(next.reference), receipt);
  assert.deepEqual(f.retention.readReceipt(f.first.reference), receipt, 'an older fixed version resolves the actual shared tombstone');
  assert.deepEqual(f.retention.cleanup({ reference: next.reference, requestId: 'cleanup-a', expectedDigest: receipt.expectedDigest }), receipt);
  assert.throws(() => f.retention.cleanup({ reference: next.reference, requestId: 'another', expectedDigest: receipt.expectedDigest }), { code: 'interactive_cleanup_parameter_conflict' });
  assert.equal(Number(f.db.prepare('PRAGMA user_version').get().user_version), 5);
});

test('a complete set of private roots is required and every current reference source blocks cleanup', async t => {
  const f = await fixture(t), before = f.counts();
  for (const source of INTERACTIVE_RETENTION_SOURCES) {
    f.setPins([{ source, reference: f.first.reference }]);
    const preview = f.retention.preview(f.first.reference);
    assert.deepEqual(preview.blockers, [{ source, count: 1 }]);
    assert.throws(() => f.retention.cleanup({ reference: f.first.reference, requestId: 'blocked', expectedDigest: preview.cleanupDigest }), { code: 'interactive_cleanup_blocked' });
  }
  f.setPins([]);
  for (const acquireRoots of [undefined, async () => f.acquireRoots(), () => Promise.resolve(f.acquireRoots()),
    () => ({ ...f.acquireRoots(), sources: {} }), () => ({ ...f.acquireRoots(), pins: [{ source: 'views', reference: { ...f.first.reference, owner: { ...owner, conversationId: 'other' } } }] })]) {
    const retention = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots });
    assert.throws(() => retention.preview(f.first.reference), { code: 'interactive_retention_unavailable' });
    assert.throws(() => retention.cleanup({ reference: f.first.reference, requestId: 'missing', expectedDigest: jsonDigest('unknown') }), { code: 'interactive_retention_unavailable' });
  }
  assert.deepEqual(f.counts(), before); assert.equal(f.retention.readReceipt(f.first.reference), null);
});

test('a referenced followup protects its actual result, and an unknown frozen ID does not become an empty root', async t => {
  const f = await fixture(t), writer = f.states.acquire({ reference: f.first.reference, identity, expectedRevision: 0 }, current);
  const state = f.states.read(f.first.reference, current);
  const frozen = await f.states.prepareFollowup({ reference: f.first.reference, identity, writer, stateRevision: 0,
    stateDigest: state.stateDigest, fields: ['$budget'], requestId: 'freeze-a' }, current);
  f.states.release({ reference: f.first.reference, identity, writer }, current);
  f.setFollowups([frozen.followupId]);
  assert.deepEqual(f.retention.preview(f.first.reference).blockers, [{ source: 'followup', count: 1 }]);
  assert.throws(() => f.clean(), { code: 'interactive_cleanup_blocked' });
  f.setFollowups(['missing-frozen']); assert.throws(() => f.clean(), { code: 'interactive_followup_unavailable' });
  assert.equal(f.store.getVersion(f.first.reference).content.initialValues.$budget, 100);
});

test('a live writer and prepared or index-pending publication responsibilities prevent collection', async t => {
  const f = await fixture(t), writer = f.states.acquire({ reference: f.first.reference, identity, expectedRevision: 0 }, current);
  assert.deepEqual(f.retention.preview(f.first.reference).blockers, [{ source: 'writer', count: 1 }]);
  f.states.release({ reference: f.first.reference, identity, writer }, current);
  const pending = await f.publish({ indexed: false });
  assert.ok(f.retention.preview(f.first.reference).blockers.some(row => row.source === 'publication'));
  f.store.markIndexed(pending.callRef, pending.indexEntry);
  const source = { ...f.first.source, toolCallId: 'prepared-only' }, callRef = { owner, conversationId: source.conversationId, toolCallId: source.toolCallId };
  f.store.beginAttempt({ callRef, source, draft }, current);
  assert.deepEqual(f.retention.preview(f.first.reference).blockers, [{ source: 'publication', count: 1 }]);
  assert.throws(() => f.clean(), { code: 'interactive_cleanup_blocked' });
  f.store.finishAttempt(callRef, { code: 'cancelled', status: 'cancelled' });
  assert.deepEqual(f.retention.preview(f.first.reference).blockers, []);
});

test('root revisions, head changes and late owner/lease invalidation cannot apply a stale preview', async t => {
  const f = await fixture(t), preview = f.retention.preview(f.first.reference);
  f.bump(); assert.throws(() => f.retention.cleanup({ reference: f.first.reference, requestId: 'stale', expectedDigest: preview.cleanupDigest }), { code: 'interactive_retention_stale' });
  const fresh = f.retention.preview(f.first.reference);
  const next = await f.publish({ base: f.first.reference, program: draft.program.replace('$budget=100', '$budget=200') });
  assert.throws(() => f.retention.cleanup({ reference: f.first.reference, requestId: 'stale', expectedDigest: fresh.cleanupDigest }), { code: 'version_conflict' });
  const late = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots,
    onStep(step) { if (step === 'cleanup_retired') f.revoke(); } });
  const latePreview = late.preview(next.reference), before = f.counts();
  assert.throws(() => late.cleanup({ reference: next.reference, requestId: 'late', expectedDigest: latePreview.cleanupDigest }), { code: 'interactive_retention_stale' });
  assert.deepEqual(f.counts(), before); assert.equal(f.store.getVersion(next.reference).content.initialValues.$budget, 200);
});

test('objects shared by another result or material remain available until their final actual reference is removed', async t => {
  const f = await fixture(t), second = await f.publish();
  assert.equal(f.first.reference.contentVersion, second.reference.contentVersion);
  assert.equal(f.retention.preview(f.first.reference).objectBytes, 0); f.clean();
  assert.equal(f.store.getVersion(second.reference).content.initialValues.$budget, 100);
  const row = f.db.prepare('SELECT object FROM versions WHERE id=?').get(second.reference.resultId), context = f.store.storage.connect(owner.workspaceId);
  const value = f.store.storage.readObject(context, row.object);
  const source = { kind: 'tool-result', conversationId: 'material-worker', toolCallId: 'material-read' };
  f.store.recordMaterial({ owner, source, value, dataLevel: 'D3_private', observedAt: now(), truncated: false, redacted: false, evidenceRefs: ['tool-result://material-read'] }, current);
  assert.equal(f.retention.preview(second.reference).objectBytes, 0); f.clean(second.reference, 'cleanup-b');
  assert.equal(f.counts().objects, 1); assert.deepEqual(f.store.readMaterial(owner, { ...source, expectedContentVersion: jsonDigest(value) }).value, value);
});

test('failure before commit rolls everything back, and lost confirmation reads the one actual persisted receipt', async t => {
  const f = await fixture(t), before = f.counts();
  for (const fault of ['cleanup_retired', 'cleanup_before_commit']) {
    const retention = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots, now,
      onStep(step) { if (step === fault) throw Error('injected fault'); } });
    const preview = retention.preview(f.first.reference);
    assert.throws(() => retention.cleanup({ reference: f.first.reference, requestId: fault, expectedDigest: preview.cleanupDigest }), /injected fault/);
    assert.deepEqual(f.counts(), before); assert.equal(retention.readReceipt(f.first.reference), null);
  }
  const lost = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots, now,
    onStep(step) { if (step === 'cleanup_committed') throw Error('confirmation lost'); } });
  const preview = lost.preview(f.first.reference);
  assert.throws(() => lost.cleanup({ reference: f.first.reference, requestId: 'lost', expectedDigest: preview.cleanupDigest }),
    error => error.code === 'interactive_cleanup_outcome_unknown' && error.cause?.message === 'confirmation lost');
  const receipt = lost.readReceipt(f.first.reference), releases = f.releases();
  assert.ok(receipt.objectBytesRemoved > 0);
  assert.deepEqual(lost.cleanup({ reference: f.first.reference, requestId: 'lost', expectedDigest: preview.cleanupDigest }), receipt);
  assert.equal(f.releases(), releases, 'reconciliation reads the original receipt without repeating collection');
});

test('a changed source under the held guard and quota failure both roll back the entire cleanup', async t => {
  const f = await fixture(t), before = f.counts();
  const changing = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots, now,
    onStep(step) { if (step === 'cleanup_before_commit') f.bump(); } });
  const preview = changing.preview(f.first.reference);
  assert.throws(() => changing.cleanup({ reference: f.first.reference, requestId: 'changed-root', expectedDigest: preview.cleanupDigest }), { code: 'interactive_retention_stale' });
  assert.deepEqual(f.counts(), before); assert.equal(f.retention.readReceipt(f.first.reference), null);
  const limited = createInteractiveResultStore({ rootDir: f.rootDir, assertCompatibility: current, maxBytes: 1 });
  try {
    const retention = createInteractiveRetention({ resultStore: limited, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots, now });
    const candidate = retention.preview(f.first.reference);
    assert.throws(() => retention.cleanup({ reference: f.first.reference, requestId: 'quota', expectedDigest: candidate.cleanupDigest }), { code: 'interactive_store_limit' });
    assert.deepEqual(f.counts(), before); assert.equal(retention.readReceipt(f.first.reference), null);
    assert.equal(f.store.getVersion(f.first.reference).content.initialValues.$budget, 100);
  } finally { limited.close(); }
});

test('corrupt checkpoints, receipts and tombstones fail closed without deleting the original rows', async t => {
  const f = await fixture(t), writer = f.states.acquire({ reference: f.first.reference, identity, expectedRevision: 0 }, current);
  f.states.save({ reference: f.first.reference, identity, writer, expectedRevision: 0, requestId: 'save', values: { $budget: 150 } }, current);
  f.states.release({ reference: f.first.reference, identity, writer }, current);
  const original = f.db.prepare('SELECT receipt FROM saves').get().receipt;
  f.db.prepare("UPDATE saves SET receipt=replace(receipt,'150','900')").run();
  const before = f.counts(); assert.throws(() => f.clean(), { code: 'interactive_state_corrupt' }); assert.deepEqual(f.counts(), before);
  f.db.prepare('UPDATE saves SET receipt=?').run(original); f.clean();
  f.db.prepare("UPDATE presentation SET body=replace(body,'Unverified','Verified') WHERE category='interactive-cleanup'").run();
  assert.throws(() => f.retention.readReceipt(f.first.reference), { code: 'interactive_cleanup_corrupt' });
});

test('the normal result quota is restored without forgetting old publication identities or resurrecting cleaned references', async t => {
  const f = await fixture(t), old = f.legacy(); old.getVersion(f.first.reference);
  let last;
  for (let index = 1; index < 256; index++) last = await f.publish();
  await assert.rejects(f.publish(), { code: 'interactive_result_limit' });
  f.db.prepare("UPDATE versions SET availability='unknown' WHERE id=?").run(last.reference.resultId);
  await assert.rejects(f.publish(), { code: 'interactive_result_limit' });
  f.db.prepare("UPDATE versions SET availability='available' WHERE id=?").run(last.reference.resultId);
  f.db.prepare("UPDATE results SET head='missing' WHERE id=?").run(last.reference.resultId);
  await assert.rejects(f.publish(), { code: 'interactive_result_limit' });
  f.db.prepare('UPDATE results SET head=? WHERE id=?').run(last.reference.contentVersion, last.reference.resultId);
  const partial = await f.publish({ base: last.reference, program: draft.program.replace('$budget=100', '$budget=200') });
  f.db.prepare("UPDATE versions SET availability='cleaned' WHERE id=? AND version=?").run(partial.reference.resultId, partial.reference.contentVersion);
  await assert.rejects(f.publish(), { code: 'interactive_result_limit' }, 'a cleaned head with another readable version still occupies a result slot');
  f.db.prepare("UPDATE versions SET availability='available' WHERE id=? AND version=?").run(partial.reference.resultId, partial.reference.contentVersion);
  f.clean();
  await assert.rejects(f.publish({ target: old }), { code: 'interactive_result_limit' });
  const added = await f.publish(); assert.notEqual(added.reference.resultId, f.first.reference.resultId);
  assert.equal(f.store.getOperation(f.first.callRef).publicationStatus, 'published');
  assert.throws(() => old.getVersion(f.first.reference), { code: 'interactive_content_cleaned' });
  const reopened = f.legacy(); assert.throws(() => reopened.getVersion(f.first.reference), { code: 'interactive_content_cleaned' });
});

test('an actual old process cannot write inside the retirement transaction or resurrect the original publication afterward', async t => {
  const f = await fixture(t), old = f.legacy(), originalContent = old.getVersion(f.first.reference).content;
  const file = path.join(f.rootDir, 'old-writer.mjs');
  const fixtureURL = new URL('./test-fixtures/retention-legacy-store.mjs', import.meta.url).href;
  writeFileSync(file, `import {createInteractiveResultStore} from ${JSON.stringify(fixtureURL)};
    const store=createInteractiveResultStore({rootDir:${JSON.stringify(f.rootDir)},assertCompatibility:()=>true});
    try{const fixed=store.getVersion(${JSON.stringify(f.first.reference)});
      store.commitPublication({owner:${JSON.stringify(owner)},source:${JSON.stringify({ ...f.first.source, toolCallId: 'concurrent-old' })},
        draft:${JSON.stringify(draft)},content:fixed.content,provenance:[],dataLevel:'D3_private',grant:{grantId:'concurrent-grant',toolCallId:'concurrent-old',granted:true}},()=>true);
      console.log(JSON.stringify({blocked:false}));
    }catch(error){console.log(JSON.stringify({blocked:true,code:error.code,message:error.message}));}finally{store.close();}`);
  let concurrent;
  const retention = createInteractiveRetention({ resultStore: f.store, stateStore: f.states, assertOwner: current, acquireRoots: f.acquireRoots, now,
    onStep(step) { if (step === 'cleanup_before_commit') concurrent = JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 5000 }).trim()); } });
  const preview = retention.preview(f.first.reference);
  const receipt = retention.cleanup({ reference: f.first.reference, requestId: 'concurrent-cleanup', expectedDigest: preview.cleanupDigest });
  assert.equal(concurrent.blocked, true); assert.match(concurrent.message, /locked|busy/i);
  assert.equal(f.counts().operations, 1); assert.equal(f.counts().objects, 0);
  const replayed = old.commitPublication({ owner, source: f.first.source, draft, content: originalContent, provenance: [], dataLevel: 'D3_private',
    grant: { grantId: 'replayed-grant', toolCallId: f.first.source.toolCallId, granted: true } }, current);
  assert.deepEqual(replayed.reference, f.first.reference); assert.equal(f.counts().objects, 0);
  const other = await f.publish({ target: old });
  assert.notEqual(other.reference.resultId, f.first.reference.resultId);
  assert.throws(() => old.getVersion(f.first.reference), { code: 'interactive_content_cleaned' });
  const presentation = createLegacyPresentation({ resultStore: old, assertOwner: current, now });
  const resource = { kind: 'interactive', reference: other.reference };
  presentation.history.save({ owner, resource, navigation: { top: 0, left: 0 } }, { owner, resource }, 'old-history');
  presentation.writeLayout(owner, { expectedRevision: 0, order: [], recent: [], interactive: { tabs: [], activeTabId: null } });
  assert.equal(presentation.history.remove('old-history', owner), true);
  assert.deepEqual(retention.readReceipt(f.first.reference), receipt, 'old history/layout writes never rewrite the cleanup category');
});

test('the tombstone bound is explicit and normal runtime composition never opens cleanup without real roots', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 256; index++) f.db.prepare('INSERT INTO presentation VALUES(?,?,?,?)').run('interactive-cleanup', `other-${index}`, encode(owner), '{}');
  assert.throws(() => f.clean(), { code: 'interactive_cleanup_limit' });
  const runtime = createInteractiveRuntime({ rootDir: f.rootDir, getBotConversationId: () => owner.conversationId, enabled: current, holdsLease: current });
  t.after(() => runtime.close());
  assert.throws(() => runtime.retention.preview(f.first.reference), { code: 'interactive_retention_unavailable' });
  assert.equal(f.store.getVersion(f.first.reference).content.initialValues.$budget, 100);
});
