import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createCoordinationLifecycle } from './coordination-lifecycle.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { validateDelegationInput } from './tool-specs.mjs';
import { buildVerifierMessage } from './goal-runner-host.mjs';
import { verificationRequestRevision } from './verification-completion.mjs';
import { createDigestQueue } from './digest.mjs';

async function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-intent-lifecycle-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true };
  const store = createWorkCoordinationStore(options);
  await store.prepare(); const release = registerWorkBudget('w', store);
  t.after(() => { release(); store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const messages = [{ id: 'input-i', inputId: 'i', role: 'user', kind: 'user_input', content: 'Research and implement the fix' }];
  const sessions = new Map(); let reviews = 0;
  const digestFile = path.join(rootDir, 'digest.json'), digests = createDigestQueue({ file: digestFile });
  const lifecycle = createCoordinationLifecycle({ holdsLease: () => true, readMessages: () => messages,
    readSession: ({ sessionId }) => sessions.get(sessionId), readGoalFacts: id => ({ plan: { planId: id, goal: 'Stage', successCriteria: [] }, evidenceIndex: [`ev:${id}`], independentVerifier: 'passed' }),
    verifyGoal: async ({ goalReview }) => { reviews++; assert.equal(goalReview.canonicalInputs[0].text, messages[0].content);
      assert.equal(goalReview.requirements.length, 2); return { passed: true, evidenceRefs: goalReview.evidenceRefs }; },
    spawn: async (_task, context) => { const id = `s${sessions.size + 1}`;
      store.bindSession(context.coordinationBinding.workId, context.coordinationBinding.goalRevision, id, { ...context.coordinationBinding, sessionId: id });
      const row = { sessionId: id, workspaceId: 'w', status: 'running', sourceRevision: `source:${id}`, observationRevision: `obs:${id}`,
        origin: { parentConversationId: 'p', workId: context.coordinationBinding.workId, anchorMessageId: 'input-i' } }; sessions.set(id, row); return row; },
    requestCancel: async () => ({ pending: false }), send: async () => ({ ok: true }), takeover: async () => ({ ok: true }) });
  const coordinator = createRunnerCoordination({ store, workspaceId: 'w', conversationId: 'p', inbox: {}, readMessages: () => messages,
    remember: message => messages.push(message), onReplied: async () => { sessions.forEach(row => { if (row.status === 'result_ready') row.status = 'accepted'; }); },
    onDeferred: message => digests.hold('w', { id: message.id, text: message.content, message }),
    resolveRoster: () => [...sessions.values()] });
  const job = { workId: 'g', kind: 'user', attemptId: 't1', userInputs: [{ inputId: 'i' }], events: [] }; coordinator.start(job);
  const context = (turnId, extra = {}) => ({ workspaceId: 'w', conversationId: 'p', workId: 'g', turnId, deliveryKey: `${turnId}:op`, currentInputAnchors: [], ...extra });
  const initial = { expectedWorkRevision: 0, expectedGoalRevision: 1, workId: 'g', sourceInputIds: ['i'], sourceEventIds: [],
    inputs: [{ inputId: 'i', kind: 'delegate', reason: 'Original implementation request' }],
    interpretation: { outcome: 'Research and implement', constraints: [], nonGoals: [], openQuestions: [], requirements: [
      { requirementId: 'research', text: 'Research cause', sourceInputIds: ['i'] }, { requirementId: 'fix', text: 'Implement fix', sourceInputIds: ['i'] }] },
    coverage: [{ requirementId: 'research', status: 'remaining', explanation: 'Not researched', sources: [] },
      { requirementId: 'fix', status: 'remaining', explanation: 'Not implemented', sources: [] }],
    disposition: { kind: 'wait', waitFor: [{ kind: 'session', id: 's1', revision: 'obs:s1' }] }, reason: 'Research in progress' };
  return { store, options, rootDir, lifecycle, coordinator, job, context, initial, sessions, messages, digests, digestFile, reviews: () => reviews,
    coordinate: (input, ctx) => lifecycle.coordinate({ reason: 'Test intention', ...input }, ctx) };
}

test('research acceptance retains the original goal, continues without user input, then closes once after actual delivery and root review', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Research' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  const initial = await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const edited = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedWorkRevision: 1,
    interpretation: { ...f.initial.interpretation, outcome: 'Rephrased outcome' } } },
  f.context('t1', { currentInputAnchors: ['input-i'], deliveryKey: 't1:rewrite' }));
  assert.equal(edited.error, 'intent_revision_required');
  assert.match(edited.message, /Omit assessment\.interpretation/);
  assert.equal(f.store.readWork('g').intentCoordination.revision, 1);
  f.coordinator.finish(f.job, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').state, 'waiting_children');
  f.sessions.get('s1').status = 'accepted';
  assert.equal(f.lifecycle.facts('w', 'p')[0].lifecycle, 'active');
  const event = { eventId: 'research-ready', sessionId: 's1', kind: 'report_available' };
  f.store.transfer([event]);
  const wake = { workId: 'g', kind: 'wake', attemptId: 't2', userInputs: [], events: [event] }; f.coordinator.start(wake);
  const continuation = { ...f.initial, interpretation: undefined, inputs: [], sourceInputIds: [], sourceEventIds: [event.eventId], expectedWorkRevision: 1,
    coverage: [{ ...f.initial.coverage[0], status: 'covered', sources: [{ sessionId: 's1', sourceRevision: 'source:s1', evidenceRefs: ['ev:s1'] }] }, f.initial.coverage[1]],
    disposition: { kind: 'continue', operationRefs: ['requirement:fix'] } };
  assert.equal((await f.coordinate({ action: 'assess', assessment: continuation }, f.context('t2', { events: [event] }))).ok, true);
  f.coordinator.finish(wake, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').state, 'runnable');
  const next = f.coordinator.recoverJob(); assert.equal(next.kind, 'wake'); assert.deepEqual(next.userInputs, []);
  assert.equal(next.sourceDecisionRef, 't2:op');
  next.attemptId = 't3'; f.coordinator.start(next);
  const ctx = f.context('t3', { sourceDecisionRef: next.sourceDecisionRef });
  const task = { action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Implement' } };
  assert.equal((await f.coordinate(task, ctx)).ok, true);
  assert.equal((await f.coordinate(task, ctx)).replayed, true); assert.equal(f.sessions.size, 2);
  f.sessions.get('s2').status = 'result_ready';
  const complete = { ...continuation, expectedWorkRevision: 2, sourceEventIds: [], sourceDecisionRef: next.sourceDecisionRef,
    coverage: [continuation.coverage[0], { ...continuation.coverage[1], status: 'covered', sources: [{ sessionId: 's2', sourceRevision: 'source:s2', evidenceRefs: ['ev:s2'] }] }],
    disposition: { kind: 'return', replyRef: 'current_turn_reply' } };
  const stale = await f.coordinate({ action: 'assess', assessment: { ...complete,
    disposition: { kind: 'return', replyRef: 't2-reply-1' } } }, ctx);
  assert.equal(stale.error, 'reply_reference_out_of_scope');
  const result = await f.coordinate({ action: 'assess', assessment: complete }, { ...ctx, deliveryKey: 't3:assess' });
  assert.equal(result.review.passed, true); assert.equal(f.reviews(), 1);
  assert.equal(f.store.readWork('g').intentCoordination.decision.disposition.replyRef, 't3-reply-1');
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'active');
  f.coordinator.finish(next, { rounds: [], turnId: 't3', yielded: true,
    providerCheckpoint: { provider: 'openai', providerId: 'p', model: 'm', messages: [] } }, [...f.sessions.values()]);
  const nativeNext = f.coordinator.recoverJob(); nativeNext.attemptId = 't4'; f.coordinator.start(nativeNext);
  assert.ok(f.coordinator.resume(nativeNext, { modelProviderId: 'p', modelId: 'm', family: 'openai' }).providerCheckpoint);
  assert.equal(nativeNext.resumedIntentDecisionRef, 't3:assess');
  assert.equal(f.coordinator.dispositionMissing(nativeNext), false, 'a real native slice carries the current judgment');
  const switched = { ...nativeNext };
  assert.equal(f.coordinator.resume(switched, { modelProviderId: 'other', modelId: 'm', family: 'openai' }).providerCheckpoint, undefined);
  assert.equal(switched.resumedIntentDecisionRef, undefined);
  assert.equal(f.coordinator.dispositionMissing(switched), true, 'fresh reasoning after a model change needs its own disposition');
  const unproven = { ...nativeNext }; f.coordinator.resume(unproven, {});
  assert.equal(unproven.resumedIntentDecisionRef, undefined, 'missing model identity cannot prove native judgment continuity');
  const message = { id: 'reply:t3:5', turnId: 't4', kind: 'agent_reply', content: 'Verified final result', meta: { workId: 'g',
    sessionStates: [...f.sessions.values()].map(row => ({ sessionId: row.sessionId, status: row.status, sourceRevision: row.sourceRevision, observationRevision: row.observationRevision })) }, sources: ['s1', 's2'] };
  f.coordinator.prepareReplies([message], nativeNext); await f.coordinator.deliver(message);
  f.coordinator.finish(nativeNext, { rounds: [], reportedSessionIds: ['s1', 's2'] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'fulfilled');
  assert.equal(f.store.readWork('g').intentCoordination.closure.replyRef, 'reply:t3:5');
  assert.equal(f.store.readWork('g').intentCoordination.closure.intentReplyRef, 't3-reply-1');
  const revision = f.store.read().revision; await f.coordinator.recover(); assert.equal(f.store.read().revision, revision);
  assert.equal(f.sessions.get('s1').status, 'accepted'); assert.equal(f.sessions.size, 2);
  f.store.close(); rmSync(path.join(f.rootDir, 'w/.read-models'), { recursive: true, force: true });
  const rebuilt = createWorkCoordinationStore(f.options); await rebuilt.prepare();
  try { assert.equal(rebuilt.readWork('g').intentCoordination.lifecycle, 'fulfilled'); assert.equal(rebuilt.read().deliveries['reply:t3:5'].settlement.status, 'applied'); }
  finally { rebuilt.close(); }
});

test('a deferred goal reply stays unaccepted and active until its actual digest is committed and settled', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Full work' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  f.coordinator.finish(f.job, { rounds: [] }, [...f.sessions.values()]);
  f.sessions.get('s1').status = 'result_ready';
  const event = { eventId: 'ready', sessionId: 's1', kind: 'report_available' }; f.store.transfer([event]);
  const job = { workId: 'g', kind: 'wake', attemptId: 't2', userInputs: [], events: [event] }; f.coordinator.start(job);
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedWorkRevision: 1, sourceInputIds: [], sourceEventIds: [event.eventId], inputs: [], interpretation: undefined,
    coverage: f.initial.coverage.map(row => ({ ...row, status: 'covered', sources: [{ sessionId: 's1', sourceRevision: 'source:s1', evidenceRefs: ['ev:s1'] }] })),
    disposition: { kind: 'return', replyRef: 't2-reply-1' } } }, f.context('t2', { events: [event] }));
  assert.equal(result.review.passed, true);
  const message = { id: 'reply:t2:8', turnId: 't2', kind: 'agent_reply', content: 'Verified root result', sources: ['s1'],
    meta: { workId: 'g', surfacing: 'digest', sessionStates: [{ sessionId: 's1', sourceRevision: 'source:s1', observationRevision: 'obs:s1', status: 'result_ready' }] } };
  f.coordinator.bindReplies([message]); await f.coordinator.deferReply(message);
  f.coordinator.finish(job, { rounds: [], deliveryPending: true }, [...f.sessions.values()]);
  assert.equal(f.messages.some(row => row.id === message.id), false); assert.equal(f.sessions.get('s1').status, 'result_ready');
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'active'); assert.equal(f.store.read().deliveries[message.id].state, 'deferred');
  const restored = createDigestQueue({ file: f.digestFile }), packet = restored.consider('w', new Date(2026, 10, 1, 10));
  assert.equal(packet.fire, true); packet.message.sources = ['forged']; packet.message.meta.intentBindings = [{ workId: 'forged' }];
  await f.coordinator.prepareDigest(packet.message); assert.deepEqual(packet.message.sources, ['s1']);
  await f.coordinator.deliver(packet.message);
  assert.equal(f.store.read().deliveries[message.id].state, 'aggregated'); assert.equal(f.store.read().deliveries[message.id].deliveredBy, packet.message.id);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'fulfilled');
  assert.equal(f.store.readWork('g').intentCoordination.closure.replyRef, packet.message.id);
  assert.equal(f.messages.filter(row => row.kind === 'agent_reply').length, 1);
});

test('a changed deferred source invalidates the aggregate, preserves root responsibility and exposes stale review facts', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Full work' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  f.sessions.get('s1').status = 'result_ready';
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial,
    coverage: f.initial.coverage.map(row => ({ ...row, status: 'covered', sources: [{ sessionId: 's1', sourceRevision: 'source:s1', evidenceRefs: ['ev:s1'] }] })),
    disposition: { kind: 'return', replyRef: 't1-reply-1' } } }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  assert.equal(result.review.passed, true);
  const message = { id: 'reply:t1:8', turnId: 't1', kind: 'agent_reply', content: 'Original result', sources: ['s1'], meta: { workId: 'g',
    sessionStates: [{ sessionId: 's1', sourceRevision: 'source:s1', observationRevision: 'obs:s1', status: 'result_ready' }] } };
  f.coordinator.bindReplies([message]); await f.coordinator.deferReply(message);
  f.sessions.get('s1').sourceRevision = 'new-content';
  const packet = f.digests.consider('w', new Date(2026, 10, 1, 10));
  assert.equal((await f.coordinator.prepareDigest(packet.message)).invalidated, true);
  assert.equal(f.messages.some(row => row.id === packet.message.id), false); assert.equal(f.store.read().deliveries[message.id].state, 'invalidated');
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'active');
  assert.equal(f.coordinator.turnFacts(f.job).intent.review.current, false);
  assert.ok(f.coordinator.pending().some(row => row.eventId.startsWith('reply-refresh:')));
});

test('a quiet final disposition reuses delivered current-goal results but never uses an old goal version or skips a fresh user answer', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Full work' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  f.sessions.get('s1').status = 'result_ready';
  const progress = { id: 'reply:t1:4', turnId: 't1', kind: 'agent_reply', content: 'Verified result', sources: ['s1'], meta: { workId: 'g',
    sessionStates: [{ sessionId: 's1', sourceRevision: 'source:s1', observationRevision: 'obs:s1', status: 'result_ready' }] } };
  f.coordinator.prepareReplies([progress]); await f.coordinator.deliver(progress);
  const event = { eventId: 'settled', sessionId: 's1', kind: 'report_available' }; f.store.transfer([event]);
  const job = { workId: 'g', kind: 'wake', attemptId: 't2', userInputs: [], events: [event] }; f.coordinator.start(job);
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedWorkRevision: 1, sourceInputIds: [], sourceEventIds: [event.eventId], inputs: [], interpretation: undefined,
    coverage: f.initial.coverage.map(row => ({ ...row, status: 'covered', sources: [{ sessionId: 's1', sourceRevision: 'source:s1', evidenceRefs: ['ev:s1'] }] })),
    disposition: { kind: 'return', replyRef: 't2-reply-1' } } }, f.context('t2', { events: [event] }));
  assert.equal(result.review.passed, true);
  f.coordinator.finish(job, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'fulfilled');
  assert.equal(f.store.readWork('g').intentCoordination.closure.replyRef, progress.id);
  assert.equal(f.messages.filter(row => row.kind === 'agent_reply').length, 1);
});

test('work query paginates relevant sessions and public event payloads with version and Bot scope checks', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  for (let i = 2; i <= 31; i++) {
    const sessionId = `s${i}`; f.store.bindSession('g', 1, sessionId);
    f.sessions.set(sessionId, { sessionId, workspaceId: 'w', status: 'running', origin: { parentConversationId: 'p' } });
  }
  const event = { eventId: 'long-diagnostic', sessionId: 's1', kind: 'interrupted', payload: { reason: 'x'.repeat(10000), privateThoughts: 'PRIVATE', apiKey: 'SECRET' } };
  f.store.transfer([event]); const context = f.context('query', { events: [event] });
  const first = await f.coordinate({ action: 'query', workId: 'g' }, context); assert.equal(first.decisionFrame.sessions[0].sessionId, 's1');
  const bySession = await f.coordinate({ action: 'query', sessionId: 's1' }, context);
  assert.equal(bySession.workId, first.workId);
  assert.deepEqual((await f.coordinate({ action: 'query', workId: bySession.workId }, context)).decisionFrame, first.decisionFrame);
  const second = await f.coordinate({ ...first.decisionFrame.retrieval }, context);
  assert.equal(second.decisionFrame.sessions.length, 7);
  assert.equal(new Set([...first.decisionFrame.sessions, ...second.decisionFrame.sessions].map(row => row.sessionId)).size, 31);
  const detail = await f.coordinate({ action: 'query', workId: 'g', eventId: event.eventId }, context);
  assert.equal(detail.truncated, true); assert.doesNotMatch(detail.payloadJson, /PRIVATE|SECRET/);
  const rest = await f.coordinate({ action: 'query', workId: 'g', eventId: event.eventId, payloadOffset: detail.nextPayloadOffset }, context);
  assert.equal(JSON.parse(detail.payloadJson + rest.payloadJson).reason.length, 10000);
  assert.equal((await f.coordinate({ action: 'query', workId: 'g' }, f.context('foreign', { conversationId: 'other' }))).error, 'out_of_scope');
  assert.equal((await f.coordinate({ action: 'query', workId: 'g', expectedRevision: 99 }, context)).error, 'frame_revision_changed');
  const original = await f.coordinate({ action: 'query', workId: 'g', inputId: 'i' }, context);
  assert.equal(original.inputText, f.messages[0].content);
  assert.equal((await f.coordinate({ action: 'query', workId: 'g', inputId: 'not-admitted' }, context)).error, 'input_out_of_scope');
});

test('same-turn disposition updates retain the admitted origin without allowing an old wait to become a future wake grant', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  const continuing = { ...f.initial, disposition: { kind: 'continue', operationRefs: ['requirement:fix'] } };
  await f.coordinate({ action: 'assess', assessment: continuing }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  f.coordinator.finish(f.job, { rounds: [] }, [...f.sessions.values()]);
  const context = f.context('t2', { sourceDecisionRef: 't1:op' });
  const wait = { ...f.initial, expectedWorkRevision: 1, sourceInputIds: [], inputs: [], interpretation: undefined, sourceDecisionRef: 't1:op' };
  assert.equal((await f.coordinate({ action: 'assess', assessment: wait }, { ...context, deliveryKey: 't2:wait' })).ok, true);
  const rejected = await f.coordinate({ action: 'assess', assessment: { ...wait, expectedWorkRevision: 2, disposition: continuing.disposition } }, f.context('t3', { sourceDecisionRef: 't1:op' }));
  assert.equal(rejected.error, 'intent_source_required');
  const query = await f.coordinate({ action: 'query', workId: 'g' }, context); assert.equal(query.sourceDecisionRef, 't1:op');
  assert.equal((await f.coordinate({ action: 'assess', assessment: { ...wait, expectedWorkRevision: 2, disposition: continuing.disposition } }, { ...context, deliveryKey: 't2:continue' })).ok, true);
  const spawned = await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Next admitted operation' } }, { ...context, deliveryKey: 't2:spawn' });
  assert.equal(spawned.ok, true, JSON.stringify(spawned)); assert.equal(f.sessions.size, 2);
});

test('long-lived work queries page input dispositions and canonical text instead of replaying unbounded input history', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  for (let batch = 0; batch < 2; batch++) {
    const ids = Array.from({ length: 64 }, (_, i) => `extra-${String(batch * 64 + i).padStart(3, '0')}`);
    ids.forEach(inputId => f.messages.push({ id: `input-${inputId}`, inputId, role: 'user', kind: 'user_input', content: inputId === 'extra-126' ? 'x'.repeat(10000) : 'Additional observation' }));
    const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedWorkRevision: batch + 1, interpretation: undefined,
      sourceInputIds: ids, inputs: ids.map(inputId => ({ inputId, kind: 'augment', reason: 'Additional factual material' })),
      disposition: { kind: 'continue', operationRefs: ['requirement:fix'] } } }, f.context(`batch-${batch}`, { currentInputAnchors: ids.map(id => `input-${id}`) }));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const context = f.context('query');
  const first = await f.coordinate({ action: 'query', workId: 'g' }, context);
  assert.equal(Object.keys(first.intent.inputs).length, 64); assert.equal(first.inputPage.total, 129);
  const second = await f.coordinate({ action: 'query', workId: 'g', ...first.inputPage }, context);
  const last = await f.coordinate({ action: 'query', workId: 'g', ...second.inputPage }, context);
  assert.equal(new Set([...Object.keys(first.intent.inputs), ...Object.keys(second.intent.inputs), ...Object.keys(last.intent.inputs)]).size, 129);
  const text = await f.coordinate({ action: 'query', workId: 'g', inputId: 'extra-126' }, context);
  const tail = await f.coordinate({ action: 'query', workId: 'g', inputId: 'extra-126', payloadOffset: text.nextPayloadOffset }, context);
  assert.equal(text.inputText.length, 8000); assert.equal(tail.inputText.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(first.decisionFrame)) <= 24000);
  assert.equal((await f.coordinate({ action: 'query', workId: 'g', expectedWorkRevision: 1, afterInputId: first.inputPage.afterInputId }, context)).error, 'frame_revision_changed');
});

test('the coordinator cannot claim another Bot work, inputs, events or retry reservations in the shared workspace journal', async t => {
  const f = await fixture(t); f.store.saveWork({ workId: 'g', state: 'delivered' });
  const checkpointRef = f.store.checkpoint('foreign', { job: { kind: 'wake', workId: 'foreign', events: [] }, outcome: { rounds: [] } });
  f.store.saveWork({ workId: 'foreign', workspaceId: 'w', parentConversationId: 'another-bot', state: 'runnable', checkpointRef, anchorInputIds: ['foreign-input'] });
  f.store.decide({ operationId: 'foreign-operation', workId: 'foreign', expectedRevision: 0, action: 'parallel', sourceInputIds: ['foreign-input'], sourceEventIds: [], reason: 'Other Bot work' },
    { parentConversationId: 'another-bot', currentInputIds: ['foreign-input'] });
  f.store.advanceTransition('foreign-operation', 'recorded', { phase: 'blocked', error: 'provider_failure' });
  assert.equal((await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedGoalRevision: 0,
    disposition: { kind: 'blocked_system', code: 'provider_failure', recoveryRef: 'foreign-operation' } } }, f.context('borrow', { currentInputAnchors: ['input-i'] }))).error, 'failure_reference_unproven');
  f.store.bindSession('foreign', 1, 'foreign-session');
  f.store.transfer([{ eventId: 'foreign-event', sessionId: 'foreign-session', kind: 'report_available', payload: { reason: 'PRIVATE_FOREIGN' } }]);
  f.sessions.set('foreign-legacy', { sessionId: 'foreign-legacy', origin: { parentConversationId: 'another-bot' } });
  f.store.transfer([{ eventId: 'foreign-legacy-event', sessionId: 'foreign-legacy', kind: 'report_available' }]);
  f.store.append({ kind: 'reply_prepared', message: { id: 'foreign-reply', content: 'PRIVATE_FOREIGN', meta: { workId: 'foreign' } } });
  assert.equal(f.coordinator.recoverJob(), null); assert.deepEqual(f.coordinator.pending(), []);
  await f.coordinator.recover(); assert.equal(f.messages.some(row => row.id === 'foreign-reply'), false); assert.equal(f.coordinator.hasPendingDelivery(), false);
  assert.equal(f.coordinator.ownedInputIds().includes('foreign-input'), false);
  assert.equal((await f.coordinate({ action: 'query', workId: 'foreign' }, f.context('query'))).error, 'out_of_scope');
  f.store.saveWork({ workId: 'foreign', state: 'retry_wait', recovery: { reservationId: 'foreign-retry', deadlineAt: '2020-01-01T00:00:00Z' } });
  f.coordinator.recoverJob(); assert.equal(f.store.readWork('foreign').state, 'retry_wait');
});

test('a fresh user correction restores the existing root from a local failure without replaying the old native checkpoint', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  f.coordinator.finish(f.job, { rounds: [{ toolCalls: [{ name: 'read_file', result: { ok: true, content: 'Old bytes' } }] }], providerCheckpoint: { opaque: 'OLD_NATIVE' } }, [...f.sessions.values()]);
  f.store.saveWork({ workId: 'g', state: 'blocked_system', recovery: { failureKind: 'fatal' }, nativeCheckpointRef: f.store.checkpoint('g', { opaque: 'OLD_NATIVE' }) });
  f.messages.push({ id: 'input-j', inputId: 'j', role: 'user', kind: 'user_input', content: 'Continue using a different method' });
  const job = { workId: 'new-intake', kind: 'user', attemptId: 'correction', userInputs: [{ inputId: 'j' }], events: [] }; f.coordinator.start(job);
  const context = f.context('correction', { workId: 'new-intake', currentInputAnchors: ['input-j'] });
  const revised = await f.coordinate({ action: 'revise', workId: 'g', sessionId: 's1', expectedRevision: 1, text: 'Use a different method' }, context);
  assert.equal(revised.ok, true);
  const assessed = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedWorkRevision: 1, expectedGoalRevision: 2,
    sourceInputIds: ['j'], inputs: [{ inputId: 'j', kind: 'revise', reason: 'Current canonical correction' }],
    interpretation: { ...f.initial.interpretation, constraints: ['Different method'] },
    disposition: { kind: 'continue', operationRefs: ['requirement:fix'] } } }, { ...context, deliveryKey: 'correction:assessment' });
  assert.equal(assessed.ok, true, JSON.stringify(assessed)); assert.equal(f.store.readWork('g').state, 'runnable');
  const next = f.coordinator.recoverJob(); assert.equal(next.workId, 'g'); assert.equal(next.sourceDecisionRef, 'correction:assessment');
  assert.deepEqual(next.userInputs, []); assert.equal(f.coordinator.resume(next, null).providerCheckpoint, undefined);
  assert.equal(f.store.readWork('g').intentCoordination.goalRevision, 2);
});

test('one reply can close two explicitly assessed original goals through separate host bindings without transferring their child scopes', async t => {
  const f = await fixture(t); f.messages[0].content = 'Research and implement both A and B';
  for (const workId of ['g', 'g2']) {
    const turnId = `initial-${workId}`, child = workId === 'g' ? 's1' : 's2';
    const job = { workId, kind: 'user', attemptId: turnId, userInputs: [{ inputId: 'i' }], events: [] }; f.coordinator.start(job);
    const context = f.context(turnId, { workId, currentInputAnchors: ['input-i'] });
    await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: workId } }, context);
    await f.coordinate({ action: 'assess', assessment: { ...f.initial, workId, disposition: { kind: 'wait', waitFor: [{ kind: 'session', id: child, revision: `obs:${child}` }] } } },
      { ...context, deliveryKey: `${turnId}:assess` });
    f.coordinator.finish(job, { rounds: [] }, [...f.sessions.values()]);
  }
  f.sessions.forEach(row => { row.status = 'result_ready'; });
  f.messages.push({ id: 'input-j', inputId: 'j', role: 'user', kind: 'user_input', content: 'Summarize both goals' });
  const job = { workId: 'summary-input', kind: 'user', attemptId: 'combined', userInputs: [{ inputId: 'j' }], events: [] }; f.coordinator.start(job);
  const context = f.context('combined', { workId: 'summary-input', currentInputAnchors: ['input-j'] });
  for (const workId of ['g', 'g2']) {
    const sessionId = workId === 'g' ? 's1' : 's2';
    const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, workId, expectedWorkRevision: 1, interpretation: undefined,
      sourceInputIds: ['j'], inputs: [{ inputId: 'j', kind: 'answer', reason: 'Return current goal results' }],
      coverage: f.initial.coverage.map(row => ({ ...row, status: 'covered', sources: [{ sessionId, sourceRevision: `source:${sessionId}`, evidenceRefs: [`ev:${sessionId}`] }] })),
      disposition: { kind: 'return', replyRef: 'combined-reply-1' } } }, { ...context, deliveryKey: `return:${workId}` });
    assert.equal(result.review.passed, true);
  }
  assert.equal(f.coordinator.requiresTaskReply(job), true);
  const message = { id: 'combined-reply-1', turnId: 'combined', kind: 'agent_reply', content: 'Both verified results', sources: ['s1', 's2'], meta: { workId: job.workId,
    sessionStates: [...f.sessions.values()].map(row => ({ sessionId: row.sessionId, status: row.status, sourceRevision: row.sourceRevision, observationRevision: row.observationRevision })), intentBindings: [{ workId: 'forged' }] } };
  f.coordinator.prepareReplies([message]); assert.deepEqual(message.meta.intentBindings.map(row => row.workId), ['g', 'g2']);
  await f.coordinator.deliver(message);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'fulfilled'); assert.equal(f.store.readWork('g2').intentCoordination.lifecycle, 'fulfilled');
  assert.deepEqual(f.store.readWork('g').sessionIds, ['s1']); assert.deepEqual(f.store.readWork('g2').sessionIds, ['s2']);
  assert.equal(f.reviews(), 2);
});

test('assessment query has no child requirement, forged typed waits fail, and simple discussion creates no mandate', async t => {
  const f = await fixture(t);
  const query = await f.coordinate({ action: 'query', workId: 'g' }, f.context('t1'));
  assert.equal(query.ok, true); assert.equal(query.goalRevision, 0); assert.equal(query.currentReplyRef, 't1-reply-1');
  assert.equal(query.decisionFrame.currentReplyRef, 't1-reply-1');
  assert.equal(f.coordinator.turnFacts({ ...f.job, attemptId: 'new-attempt' }).currentReplyRef, 'new-attempt-reply-1');
  assert.equal(f.coordinator.dispositionMissing(f.job), false); assert.equal(f.store.read().mandates, undefined);
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedGoalRevision: 0 } }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  assert.equal(result.error, 'wait_source_stale');
  assert.equal(validateDelegationInput('coordinate_work', { action: 'query', workId: 'g', reason: 'Read facts' }).ok, true);
  assert.equal(validateDelegationInput('coordinate_work', { action: 'assess', assessment: f.initial, reason: 'Assign responsibility' }).ok, true);
  assert.equal(validateDelegationInput('coordinate_work', { action: 'assess', assessment: { ...f.initial, permissionGrant: 'fake' }, reason: 'Assign' }).ok, false);
});

test('stale session waits return only current in-scope facts and cannot park a ready result', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } },
    f.context('spawn', { currentInputAnchors: ['input-i'] }));
  const session = f.sessions.get('s1');
  const context = f.context('t1', { currentInputAnchors: ['input-i'] });
  const assessWait = (id, revision, extra = {}) => f.coordinate({ action: 'assess', assessment: { ...f.initial,
    disposition: { kind: 'wait', waitFor: [{ kind: 'session', id, revision }] } } }, { ...context, ...extra });
  const state = () => [{ sessionId: 's1', status: session.status, sourceRevision: session.sourceRevision,
    observationRevision: session.observationRevision }];

  const stale = await assessWait('s1', session.sourceRevision);
  assert.equal(stale.error, 'wait_source_stale');
  assert.deepEqual(stale.sessionStates, state());
  assert.match(stale.message, /current observationRevision/);
  assert.deepEqual(await assessWait('foreign', 'obs:foreign'), { ok: false, error: 'wait_source_stale' });

  session.status = 'result_ready';
  const ready = await assessWait('s1', session.observationRevision);
  assert.equal(ready.error, 'wait_source_stale');
  assert.deepEqual(ready.sessionStates, state());
  assert.match(ready.message, /Review the current result or exception/);
  assert.equal(f.store.readWork('g').intentCoordination, undefined);
});

test('root review identifies stale versions and unindexed references without exposing the task index', async t => {
  const f = await fixture(t);
  const context = f.context('t1', { currentInputAnchors: ['input-i'] });
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, context);
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial,
    coverage: f.initial.coverage.map((row, index) => ({ ...row, status: 'covered', sources: [{
      sessionId: 's1', sourceRevision: index === 0 ? 'stale' : 'source:s1', evidenceRefs: ['tool-result://bot-query'],
    }] })),
    disposition: { kind: 'return', replyRef: 'current_turn_reply' },
  } }, { ...context, deliveryKey: 'review' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.review.sourceIssues, [
    { requirementId: 'research', sessionId: 's1', sourceRevision: 'source:s1', reason: 'source_revision_changed' },
    { requirementId: 'fix', sessionId: 's1', sourceRevision: 'source:s1', reason: 'reference_not_indexed' },
  ]);
  assert.equal(result.review.error, 'goal_evidence_stale');
  assert.doesNotMatch(JSON.stringify(result.review), /ev:s1|bot-query/);
  assert.equal(f.reviews(), 0);
});

test('a model cannot invent physical failure truth or borrow another work failure; semantic unresolved responsibility remains active', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Original' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  const blocked = code => ({ ...f.initial, disposition: { kind: 'blocked_system', code, recoveryRef: 'work:g' } });
  const context = f.context('t1', { currentInputAnchors: ['input-i'] });
  assert.equal((await f.coordinate({ action: 'assess', assessment: blocked('invented_provider_failure') }, context)).error, 'failure_reference_unproven');
  assert.equal((await f.coordinate({ action: 'assess', assessment: blocked('intent_decision_unresolved') }, context)).error, 'existing_work_requires_wait');
  f.sessions.get('s1').status = 'accepted';
  assert.equal((await f.coordinate({ action: 'assess', assessment: blocked('intent_decision_unresolved') }, context)).ok, true);
  f.coordinator.finish(f.job, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').state, 'blocked_system'); assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'active');
});

test('root reviewer receives the entire canonical goal as factual input without changing child criteria or acceptance', () => {
  const message = buildVerifierMessage({ plan: { goal: 'Research', successCriteria: [] }, goalReview: { canonicalInputs: [{ text: 'Research AND implement' }], requirements: ['Research', 'Implement'] } });
  assert.match(message, /ALL root requirements/); assert.match(message, /Research AND implement/);
  assert.match(message, /never accepts a child/);
  assert.equal(verificationRequestRevision('child-content'), 'child-content');
  assert.notEqual(verificationRequestRevision('child-content', { goalRevision: 1 }), 'child-content');
  assert.notEqual(verificationRequestRevision('child-content', { goalRevision: 1 }), verificationRequestRevision('child-content', { goalRevision: 2 }));
});
