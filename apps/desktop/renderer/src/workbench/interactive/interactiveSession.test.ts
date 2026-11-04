import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { type TestContext } from 'node:test';
import { prepareEvaluator, validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore, createInteractiveStateStore, createInteractiveViewService } from '@peer-agent/runtime-node/interactive-results';
import type { InteractiveOpenView, InteractiveResultsApi } from '@peer-agent/protocol';
import { createInteractiveSession } from './interactiveSession.ts';

const program = '$x=2\n$name="Trial"\n$budget=100\nroot=Col([Input("name","Name",$name),NumberInput("x","Divisor",$x,0,10,1),NumberInput("budget","Budget",$budget,0,1000,1),Metric("Ratio",10/$x),Button("Set divisor",@Set($x,4))])';
async function fixture(t: TestContext) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-session-')));
  const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true });
  const states = createInteractiveStateStore({ resultStore: results });
  const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const draft = { publication: { kind: 'create' as const }, title: 'Trial', textFallback: 'Model trial, unverified.', inputs: [], program };
  const content = await validateDraft(draft);
  const receipt = results.commitPublication({ owner, source: { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' },
    draft, content, provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish-a', grantId: 'grant-a', granted: true } }, () => true);
  results.markIndexed(receipt.callRef, receipt.indexEntry);
  const sender = new EventEmitter(), service = createInteractiveViewService({ resultStore: results, stateStore: states,
    resolveSource: () => ({ owner, assertCurrent: () => true }) });
  const adapt = (actual: EventEmitter) => Object.fromEntries(['open', 'readState', 'acquire', 'save', 'release', 'prepareFollowup']
    .map(method => [method, async (request: unknown) => (service as unknown as Record<string, (sender: EventEmitter, request: unknown) => unknown>)[method](actual, request)])) as unknown as InteractiveResultsApi;
  const api = adapt(sender), opened = await api.open({ reference: receipt.reference, requestId: 'open-a' });
  if (!opened.ok) throw Error(opened.code);
  let sequence = 0;
  const evaluator = await prepareEvaluator(content), session = createInteractiveSession({ api, opened, evaluator, createId: () => `request-${++sequence}` });
  t.after(() => { service.dispose(); states.close(); results.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { api, opened, session, states, results, receipt, service, adapt, evaluator };
}

test('protected pasted state stays in unsaved memory, cannot reach host or SDK, and can be corrected', async t => {
  const f = await fixture(t), originalSave = f.api.save;
  let saves = 0;
  f.api.save = async request => { saves++; return originalSave(request); };
  assert.equal(await f.session.acquire(), true);
  for (const raw of ['sk-examplecredential012345678901234567890', JSON.stringify({ approvalId: 'example', capabilityId: 'local.file.write', argsDigest: 'example' })]) {
    assert.equal(f.session.editText('$name', raw), true);
    assert.equal(f.session.snapshot().inputDrafts.$name, raw);
    assert.equal(f.session.snapshot().sdkValues.$name, 'Trial');
    assert.equal(f.session.snapshot().calculationError, 'interactive_state_protected');
    assert.equal(await f.session.flush(), false); assert.equal(saves, 0);
    assert.equal(f.session.snapshot().confirmed.stateRevision, 0);
    assert.equal(f.states.read(f.receipt.reference, () => true).values.$name, 'Trial');
  }
  assert.equal(f.session.editText('$name', 'Corrected'), true);
  assert.equal(await f.session.flush(), true); assert.equal(saves, 1);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$name, 'Corrected');
});

test('a replaced owner settles the exact pending request and preserves only later local edits until explicit discard', async t => {
  const f = await fixture(t), originalSave = f.api.save;
  const attempts: Parameters<InteractiveResultsApi['save']>[0][] = [];
  f.api.save = async request => {
    attempts.push(request);
    if (attempts.length === 1) { assert.equal((await originalSave(request)).ok, true); throw Error('lost save confirmation'); }
    return attempts.length === 2 ? { ok: false, code: 'interactive_owner_replaced' }
      : { ok: false, code: 'interactive_owner_replaced', saveStatus: 'committed' };
  };
  assert.equal(await f.session.acquire(), true);
  f.session.editText('$budget', '80');
  assert.equal(await f.session.flush(), false);
  f.session.editText('$name', 'Local later input');
  assert.equal(await f.session.flush(), false);
  assert.equal(f.session.snapshot().ownerReplaced, true);
  assert.equal(await f.session.abandonReplacedOwner(), false);
  assert.equal(await f.session.close(), false);
  assert.equal(await f.session.acquire(true), false);
  assert.equal(f.session.editText('$name', 'Late input'), false);
  assert.equal(await f.session.prepareSelection(['$name']), null);
  assert.equal(await f.session.flush(), false);
  assert.deepEqual(attempts, [attempts[0], attempts[0], attempts[0]]);
  assert.deepEqual(f.session.recoveryFields(), ['$name']);
  assert.equal(f.session.snapshot().savePending, false);
  assert.equal(f.session.snapshot().inputDrafts.$name, 'Local later input');
  assert.equal(await f.session.abandonReplacedOwner(), true);
  assert.equal(await f.session.close(), true);
  assert.deepEqual(f.session.snapshot().inputDrafts, {});
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$budget, 80);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$name, 'Trial');
});

test('rechecking a protected local edit after owner replacement never submits its raw value', async t => {
  const f = await fixture(t);
  assert.equal(await f.session.acquire(), true);
  f.session.editText('$name', 'sk-examplecredential012345678901234567890');
  f.api.readState = async () => ({ ok: false, code: 'interactive_owner_replaced' });
  f.api.save = async () => { throw Error('protected edit reached the save API'); };
  assert.equal(await f.session.close(), false);
  assert.equal(f.session.snapshot().ownerReplaced, true);
  assert.deepEqual(f.session.recoveryFields(), ['$name']);
  assert.equal(await f.session.abandonReplacedOwner(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).stateRevision, 0);
});

test('IME and incomplete numeric drafts stay local; legal division-by-zero parameters save without becoming SDK output', async t => {
  const f = await fixture(t);
  assert.equal(await f.session.flush(), true, 'an unchanged readonly view needs no writer');
  assert.equal(await f.session.acquire(), true);
  f.session.editText('$name', '试算中', true);
  assert.equal(f.session.snapshot().values.$name, 'Trial');
  assert.equal(f.session.snapshot().inputDrafts.$name, '试算中');
  assert.equal(await f.session.flush(), false);
  assert.equal(await f.session.prepareSelection(['$name']), null);
  assert.equal(f.states.read(f.receipt.reference, () => true).stateRevision, 0);
  f.session.editText('$name', '试算', false);
  assert.equal(f.session.snapshot().values.$name, '试算');
  f.session.editText('$x', '-');
  assert.equal(f.session.snapshot().values.$x, 2);
  assert.equal(f.session.snapshot().calculationError, 'input_incomplete');
  assert.equal(await f.session.flush(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).inputDrafts.$x, '-');
  f.session.editText('$x', '0');
  assert.equal(f.session.snapshot().calculationError, 'division_by_zero');
  assert.equal(f.session.snapshot().values.$x, 0);
  assert.equal(f.session.snapshot().sdkValues.$x, 2);
  assert.equal(await f.session.flush(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 0);
  f.session.editText('$x', '5');
  assert.equal(f.session.snapshot().calculationError, null);
  assert.equal(f.session.snapshot().sdkValues.$x, 5);
});

test('draft preparation awaits its own receipt, retries the same frozen values after edits/takeover and rejects a mismatched acknowledgment', async t => {
  const f = await fixture(t), followups: string[] = [];
  let acknowledge: (() => void) | undefined, attempt = 0;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.api.prepareDraft = async request => {
    followups.push(request.followupId);
    started();
    if (++attempt === 1) { await new Promise<void>(resolve => { acknowledge = resolve; }); return { ok: false, code: 'draft_preparation_unconfirmed' }; }
    return { ok: true, followupId: attempt === 2 ? 'wrong-receipt' : request.followupId };
  };
  await f.session.acquire(); f.session.editText('$x', '3');
  const preparing = f.session.prepareDraft(['$x']);
  await Promise.race([entered, preparing.then(() => { throw Error('Preparation ended before entering the draft service'); })]);
  assert.equal(f.session.snapshot().preparation, 'frozen'); assert.equal(f.session.snapshot().draftPreparation, 'preparing');
  const frozen = f.session.snapshot().frozen!; assert.equal(frozen.values.$x, 3);
  f.session.editText('$x', '7'); assert.equal(await f.session.flush(), true);
  acknowledge!(); assert.equal(await preparing, false); assert.equal(f.session.snapshot().draftPreparation, 'failed');
  const otherApi = f.adapt(new EventEmitter()), other = await otherApi.open({ reference: f.receipt.reference, requestId: 'takeover-view' });
  if (!other.ok) throw Error(other.code);
  await otherApi.acquire({ handle: other.handle, expectedRevision: 2, takeover: true });
  assert.equal(await f.session.acquire(), false);
  assert.equal(await f.session.prepareDraft(), false); assert.equal(f.session.snapshot().draftError, 'interactive_draft_receipt_invalid');
  assert.equal(await f.session.prepareDraft(), true); assert.equal(f.session.snapshot().draftPreparation, 'prepared');
  assert.deepEqual(followups, Array(3).fill(frozen.followupId));
  assert.equal(f.states.readFollowup(frozen.recipient, frozen.followupId).values.$x, 3);
  assert.equal(f.session.snapshot().values.$x, 7); assert.equal(f.session.snapshot().phase, 'writer_lost');
});

test('an unfinished new selection never falls back to the last frozen values, and an older bridge cannot claim preparation', async t => {
  const f = await fixture(t); await f.session.acquire();
  assert.equal(f.session.canPrepareDraft(), false); assert.equal(await f.session.prepareDraft(['$x']), false);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 0);
  let calls = 0; f.api.prepareDraft = async request => { calls++; return { ok: true, followupId: request.followupId }; };
  assert.equal(await f.session.prepareDraft(['$x']), true); assert.equal(calls, 1);
  f.session.editText('$x', '-'); assert.equal(await f.session.prepareDraft(['$x']), false);
  assert.equal(f.session.snapshot().frozen, null); assert.equal(await f.session.prepareDraft(), false); assert.equal(calls, 1);
  assert.equal(f.session.snapshot().inputDrafts.$x, '-'); assert.equal(f.session.snapshot().draftPreparation, 'failed');
  assert.equal(await f.session.prepareSelection([]), null);
});

test('lost save acknowledgment retries the original request before saving newer edits', async t => {
  const f = await fixture(t), save = f.api.save, calls: Parameters<InteractiveResultsApi['save']>[0][] = [];
  let lose = true;
  f.api.save = async request => { calls.push(structuredClone(request)); const reply = await save(request); if (lose) { lose = false; throw Error('ack lost'); } return reply; };
  await f.session.acquire(); f.session.editText('$x', '3');
  assert.equal(await f.session.flush(), false);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 0);
  assert.equal(f.session.snapshot().dirty, true);
  f.session.editText('$x', '5');
  assert.equal(await f.session.flush(), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[2].expectedRevision, 1);
  assert.equal(calls[2].values.$x, 5);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 2);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 5);
});

for (const committed of [false, true]) for (const settleFirst of [false, true]) test(`takeover settles a lost save without replacing local input: committed=${committed}, settleFirst=${settleFirst}`, async t => {
  const f = await fixture(t), save = f.api.save, calls: Parameters<InteractiveResultsApi['save']>[0][] = [];
  let lose = true;
  f.api.save = async request => {
    calls.push(structuredClone(request));
    if (lose) { lose = false; if (committed) await save(request); throw Error('ack lost'); }
    return save(request);
  };
  await f.session.acquire(); f.session.editText('$x', '3'); assert.equal(await f.session.flush(), false);
  const newerText = committed ? settleFirst ? '4.' : '4.00' : null;
  const expectedValue = newerText === '4.00' ? 4 : 3;
  if (newerText) f.session.editText('$x', newerText);
  const otherApi = f.adapt(new EventEmitter()), opened = await otherApi.open({ reference: f.receipt.reference, requestId: 'open-b' });
  if (!opened.ok) throw Error(opened.code);
  const other = createInteractiveSession({ api: otherApi, opened, evaluator: f.evaluator });
  assert.equal(await other.acquire(true), true); other.editText('$x', '7'); assert.equal(await other.flush(), true);
  if (settleFirst) { assert.equal(await f.session.flush(), false); assert.equal(f.session.snapshot().phase, 'writer_lost'); }
  assert.equal(await f.session.acquire(true), true);
  assert.deepEqual(calls[1], calls[0], 'settlement keeps the original writer, CAS base, request ID and values');
  assert.equal(f.session.snapshot().confirmed.values.$x, 7);
  assert.equal(f.session.snapshot().values.$x, expectedValue);
  assert.equal(f.session.snapshot().inputDrafts.$x, newerText ?? '3');
  assert.equal(f.session.snapshot().dirty, true);
  assert.equal(await f.session.flush(), true);
  assert.notEqual(calls.at(-1)!.requestId, calls[0].requestId, 'a new writer/base requires a new save operation identity');
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, expectedValue);
  assert.equal(f.states.read(f.receipt.reference, () => true).inputDrafts.$x, newerText ?? '3');
});

test('an unqualified old-host stale response keeps the unknown request and prevents takeover, close and freezing', async t => {
  const f = await fixture(t), save = f.api.save, acquire = f.api.acquire;
  let acquireCalls = 0;
  f.api.acquire = async request => { acquireCalls++; return acquire(request); };
  f.api.save = async () => { throw Error('unconfirmed dispatch'); };
  await f.session.acquire(); f.session.editText('$x', '3'); assert.equal(await f.session.flush(), false);
  f.api.save = async () => ({ ok: false, code: 'interactive_writer_stale' });
  assert.equal(await f.session.acquire(true), false); assert.equal(acquireCalls, 1);
  assert.equal(await f.session.close(), false);
  assert.equal(await f.session.prepareSelection(['$x']), null);
  assert.equal(f.session.snapshot().inputDrafts.$x, '3');
  f.api.save = save;
  assert.equal(await f.session.acquire(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 3);
});

test('an absent save below the actual CAS checkpoint can settle without stealing another writer or reusing its operation ID', async t => {
  const f = await fixture(t), save = f.api.save;
  let lose = true;
  f.api.save = async request => { if (lose) { lose = false; throw Error('dispatch unconfirmed'); } return save(request); };
  await f.session.acquire(); f.session.editText('$x', '3'); assert.equal(await f.session.flush(), false);
  f.states.save({ reference: f.receipt.reference, identity: f.opened.handle, writer: f.session.snapshot().writer!, expectedRevision: 0,
    requestId: 'other-confirmed-save', values: { $x: 7, $name: 'Trial', $budget: 100 }, inputDrafts: {} }, () => true);
  assert.equal(await f.session.acquire(), true);
  assert.equal(f.session.snapshot().values.$x, 3); assert.equal(f.session.snapshot().confirmed.values.$x, 7);
  assert.equal(await f.session.flush(), true);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 2);
});

test('a clean view without an unresolved save adopts the actual checkpoint when it explicitly takes over', async t => {
  const f = await fixture(t); await f.session.acquire(); f.session.editText('$x', '3'); await f.session.flush();
  const otherApi = f.adapt(new EventEmitter()), opened = await otherApi.open({ reference: f.receipt.reference, requestId: 'open-b' });
  if (!opened.ok) throw Error(opened.code);
  const other = createInteractiveSession({ api: otherApi, opened, evaluator: f.evaluator });
  await other.acquire(true); other.editText('$x', '7'); await other.flush();
  assert.equal(await f.session.acquire(), false);
  assert.equal(await f.session.acquire(true), true);
  assert.equal(f.session.snapshot().values.$x, 7);
  assert.equal(f.session.snapshot().dirty, false);
});

test('explicit recovery of a lost composition surface saves raw text without promoting it to effective or frozen values', async t => {
  const f = await fixture(t); await f.session.acquire();
  f.session.editText('$name', '未完成的输入', true);
  assert.equal(await f.session.flush(), false);
  f.session.preserveInterruptedComposition();
  assert.equal(f.session.snapshot().composing, false);
  assert.equal(f.session.snapshot().values.$name, 'Trial');
  assert.equal(f.session.snapshot().inputDrafts.$name, '未完成的输入');
  assert.equal(f.session.snapshot().calculationError, 'input_incomplete');
  assert.equal(await f.session.flush(), true);
  const saved = f.states.read(f.receipt.reference, () => true);
  assert.equal(saved.inputDrafts.$name, '未完成的输入'); assert.equal(saved.values.$name, 'Trial');
  assert.equal(await f.session.prepareSelection(['$name']), null);
});

test('preparation saves the clicked candidate before freezing; edits during the acknowledgment stay in the original view', async t => {
  const f = await fixture(t), save = f.api.save;
  let acknowledge: (() => void) | undefined;
  f.api.save = async request => { const reply = await save(request); await new Promise<void>(resolve => { acknowledge = resolve; }); return reply; };
  await f.session.acquire(); f.session.editText('$x', '3');
  const preparing = f.session.prepareSelection(['$x']);
  assert.equal(await f.session.prepareSelection(['$budget']), null, 'a duplicate click cannot replace the in-flight candidate');
  while (!acknowledge) await new Promise(resolve => setImmediate(resolve));
  f.session.editText('$x', '5'); acknowledge();
  const frozen = await preparing;
  assert.equal(frozen?.values.$x, 3);
  assert.equal(f.session.snapshot().values.$x, 5);
  assert.equal(f.session.snapshot().dirty, true);
  f.api.save = save; await f.session.flush();
  assert.equal(f.states.readFollowup(f.receipt.reference.owner, frozen!.followupId).values.$x, 3);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 5);
});

test('an explicit retry confirms the same clicked values with a new save identity when the old checkpoint could not freeze', async t => {
  const f = await fixture(t), prepare = f.api.prepareFollowup, save = f.api.save;
  const saves: Parameters<InteractiveResultsApi['save']>[0][] = [];
  f.api.save = async request => { saves.push(structuredClone(request)); return save(request); };
  let advance = true;
  f.api.prepareFollowup = async request => {
    if (advance) {
      advance = false;
      const snapshot = f.states.read(f.receipt.reference, () => true);
      f.states.save({ reference: f.receipt.reference, identity: f.opened.handle, writer: f.session.snapshot().writer!,
        expectedRevision: snapshot.stateRevision, requestId: 'intervening-checkpoint', values: { ...snapshot.values, $x: 7 }, inputDrafts: {} }, () => true);
      f.session.editText('$x', '5');
    }
    return prepare(request);
  };
  await f.session.acquire(); f.session.editText('$x', '3');
  assert.equal(await f.session.prepareSelection(['$x']), null);
  assert.equal(f.session.snapshot().preparationError, 'state_revision_unavailable');
  assert.equal(f.session.snapshot().values.$x, 5);
  assert.equal(await f.session.acquire(), true);
  const frozen = await f.session.retrySelection();
  assert.equal(frozen?.values.$x, 3); assert.match(frozen!.excerpt, /Divisor: 3/);
  assert.equal(saves.length, 2); assert.notEqual(saves[0].requestId, saves[1].requestId);
  assert.equal(saves[1].expectedRevision, 2); assert.equal(saves[1].values.$x, 3);
  assert.equal(f.session.snapshot().values.$x, 5); assert.equal(f.session.snapshot().dirty, true);
  assert.equal(await f.session.flush(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 5);
  assert.equal(f.states.readFollowup(f.receipt.reference.owner, frozen!.followupId).values.$x, 3);
});

test('lost freeze acknowledgment uses the same confirmed revision even after a newer checkpoint', async t => {
  const f = await fixture(t), prepare = f.api.prepareFollowup, calls: Parameters<InteractiveResultsApi['prepareFollowup']>[0][] = [];
  let lose = true;
  f.api.prepareFollowup = async request => { calls.push(structuredClone(request)); const reply = await prepare(request); if (lose) { lose = false; throw Error('ack lost'); } return reply; };
  await f.session.acquire(); f.session.editText('$x', '3');
  assert.equal(await f.session.prepareSelection(['$x']), null);
  f.session.editText('$x', '5'); await f.session.flush();
  const frozen = await f.session.retrySelection();
  assert.equal(frozen?.values.$x, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 2);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 5);
});

test('writer takeover preserves the old editor draft and requires explicit reacquisition before it can save', async t => {
  const f = await fixture(t); await f.session.acquire(); f.session.editText('$x', '3');
  const otherApi = f.adapt(new EventEmitter()), opened = await otherApi.open({ reference: f.receipt.reference, requestId: 'open-b' });
  if (!opened.ok) throw Error(opened.code);
  const other = createInteractiveSession({ api: otherApi, opened: opened as InteractiveOpenView, evaluator: f.evaluator });
  assert.equal(await other.acquire(), false);
  assert.equal(await other.acquire(true), true);
  other.editText('$x', '5'); await other.flush();
  assert.equal(await f.session.flush(), false);
  assert.equal(f.session.snapshot().phase, 'writer_lost');
  assert.equal(f.session.snapshot().inputDrafts.$x, '3');
  assert.equal(f.session.snapshot().values.$x, 3);
  assert.equal(await f.session.acquire(true), true);
  assert.equal(await f.session.flush(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 3);
});

test('local button updates preserve unrelated unfinished input and cannot publish or invoke a model', async t => {
  const f = await fixture(t); await f.session.acquire(); f.session.editText('$budget', '-');
  const plan = f.evaluator.evaluate(f.session.snapshot().values).tree.props.children as { props: { action: unknown } }[];
  assert.equal(f.session.applyAction(plan[4].props.action), true);
  assert.equal(f.session.snapshot().values.$x, 4);
  assert.equal(f.session.snapshot().inputDrafts.$budget, '-');
  assert.equal(f.session.snapshot().calculationError, 'input_incomplete');
  assert.equal(f.session.applyAction({ steps: [{ type: 'tool' }] }), false);
  assert.equal(f.results.storage.connect(f.receipt.reference.owner.workspaceId)!.db.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n, 1);
});

test('failed close keeps the editor; retrying an already-applied release is safe', async t => {
  const f = await fixture(t), release = f.api.release;
  let lose = true;
  f.api.release = async request => { const reply = await release(request); if (lose) { lose = false; throw Error('ack lost'); } return reply; };
  await f.session.acquire(); f.session.editText('$x', '3');
  assert.equal(await f.session.close(), false);
  assert.equal(f.session.snapshot().phase, 'closing');
  assert.equal(f.session.snapshot().values.$x, 3);
  assert.equal(f.session.editText('$x', '9'), false, 'an unconfirmed release cannot advertise a live editor');
  assert.equal(await f.session.close(), true);
  assert.equal(f.session.snapshot().phase, 'closed');
});

test('new edits while close waits for a save keep the tab and must be saved by a later close', async t => {
  const f = await fixture(t), save = f.api.save, release = f.api.release;
  let acknowledge!: () => void, saving!: () => void, releases = 0;
  const started = new Promise<void>(resolve => { saving = resolve; });
  f.api.save = async request => { const reply = await save(request); await new Promise<void>(resolve => { acknowledge = resolve; saving(); }); return reply; };
  f.api.release = async request => { releases++; return release(request); };
  await f.session.acquire(); f.session.editText('$x', '3'); const closing = f.session.close(); await started;
  f.session.editText('$x', '5'); acknowledge(); assert.equal(await closing, false);
  assert.equal(releases, 0); assert.equal(f.session.snapshot().values.$x, 5); assert.equal(f.session.snapshot().confirmed.values.$x, 3);
  f.api.save = save; assert.equal(await f.session.close(), true);
  assert.equal(f.states.read(f.receipt.reference, () => true).values.$x, 5);
});

test('reacquiring an existing writer resolves its original lost save acknowledgement before accepting a new checkpoint', async t => {
  const f = await fixture(t), save = f.api.save, calls: Parameters<InteractiveResultsApi['save']>[0][] = [];
  let lose = true;
  f.api.save = async request => { calls.push(structuredClone(request)); const reply = await save(request); if (lose) { lose = false; throw Error('ack lost'); } return reply; };
  await f.session.acquire(); f.session.editText('$x', '3'); assert.equal(await f.session.flush(), false);
  f.session.editText('$x', '5'); assert.equal(await f.session.acquire(), true);
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[2].values.$x, 5);
  assert.equal(f.session.snapshot().confirmed.stateRevision, 2); assert.equal(f.session.snapshot().dirty, false);
});
