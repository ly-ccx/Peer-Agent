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
  assert.equal(f.session.snapshot().phase, 'ready');
  assert.equal(f.session.snapshot().values.$x, 3);
  assert.equal(await f.session.close(), true);
  assert.equal(f.session.snapshot().phase, 'closed');
});
