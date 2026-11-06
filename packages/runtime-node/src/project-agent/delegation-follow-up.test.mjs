import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { registerWorkBudget } from './work-budget.mjs';

const input = { inputId: 'request', text: '去掉导航项' };
const task = title => ({ title, anchorMessageIds: ['request'], brief: '临时导航夹具', readOnly: false, kind: 'docs', requiredCapabilities: [], successCriteria: [{ kind: 'model_review', description: 'fixture' }] });
const dispatch = (error = 'anchor_not_found', title = '导航') => ({ name: 'spawn_session', toolCallId: 'spawn-call', input: task(title), result: { ok: false, error } });
const reply = { name: 'post_reply', input: { replyTo: ['input-request'], text: '仍在处理' }, result: { ok: true } };
async function world(t, { start = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-dispatch-follow-up-'));
  const options = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true };
  let store = createWorkCoordinationStore(options); await store.prepare(); let release = registerWorkBudget('w', store);
  const messages = [{ id: 'input-request', ...input, role: 'user', kind: 'user_input' }];
  const inbox = createProjectInbox({ rootDir: root });
  const make = () => createRunnerCoordination({ store, inbox, workspaceId: 'w', conversationId: 'parent',
    readMessages: () => messages, remember: msg => messages.push(msg), resolveRoster: () => [] });
  let coordination = make(); const job = { kind: 'user', workId: 'work', attemptId: 'turn', userInputs: [input], events: [] };
  if (start) coordination.start(job);
  t.after(() => { release(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { job, messages, get store() { return store; }, get coordination() { return coordination; },
    work: () => store.readWork('work'),
    finish(calls, extra = {}) { return coordination.finish(job, { turnId: job.attemptId, rounds: [{ toolCalls: calls }], ...extra }, []); },
    async restart() { release(); store.close(); store = createWorkCoordinationStore(options); await store.prepare(); release = registerWorkBudget('w', store); coordination = make(); } };
}

test('A7/A9 rejected dispatch stays pending after a successful reply and restart; fresh cognition needs no replay', async t => {
  const f = await world(t); f.finish([dispatch(), reply]);
  assert.equal(f.work().state, 'runnable'); assert.equal(f.work().delegationFollowUp.blockers[0].error, 'anchor_not_found');
  await f.restart(); const resumed = f.coordination.recoverJob();
  assert.equal(resumed.workId, 'work'); assert.equal(f.coordination.resume(resumed).providerCheckpoint, undefined);
});

test('A4 current user or mandate refusal remains blocked after identity repair, with Bot follow-up', async t => {
  for (const error of ['current_user_required', 'mandate_inactive', 'material_out_of_scope', 'coordination_action_denied']) {
    const f = await world(t); f.finish([dispatch(error), reply]);
    assert.equal(f.work().state, 'blocked_system', error);
    assert.equal(f.work().delegationFollowUp.blockers[0].error, error);
    assert.equal(f.coordination.recoverJob(), null, 'do not automatically bypass the second gate');
  }
});

test('A6 correcting a rejected anchor clears the original obligation through its recovery identity', async t => {
  const corrected = { ...dispatch(), input: { ...task('导航'), anchorMessageIds: ['input-request'] }, result: { ok: true, sessionId: 'real' } };
  for (const error of ['anchor_not_found', 'anchor_not_user_input', 'anchor_ambiguous', 'anchor_out_of_scope']) {
    const f = await world(t);
    f.finish([{ ...dispatch(error), input: { ...task('导航'), anchorMessageIds: ['missing'] } }]);
    assert.equal(f.work().delegationFollowUp.blockers[0].error, error);
    assert.equal(typeof f.work().delegationFollowUp.blockers[0].recoveryKey, 'string');
    await f.restart();
    f.finish([corrected, reply]);
    assert.equal(f.work().delegationFollowUp, undefined, error);
  }
  const differentTask = await world(t);
  differentTask.finish([dispatch()]);
  const kept = differentTask.work().delegationFollowUp.blockers[0].taskKey;
  differentTask.finish([{ ...corrected, input: { ...task('别的任务'), anchorMessageIds: ['input-request'] } }]);
  assert.equal(differentTask.work().delegationFollowUp.blockers[0].taskKey, kept);
  const denied = await world(t);
  denied.finish([{ ...dispatch('current_user_required'), input: { ...task('导航'), anchorMessageIds: ['missing'] } }]);
  denied.finish([corrected]);
  assert.equal(denied.work().delegationFollowUp.blockers[0].error, 'current_user_required');
  const coordinated = await world(t);
  const rejectedCoordination = { name: 'coordinate_work', toolCallId: 'coord-call', result: { ok: false, error: 'anchor_not_found' },
    input: { action: 'parallel', task: { ...task('导航'), anchorMessageIds: ['missing'] } } };
  coordinated.finish([rejectedCoordination]);
  coordinated.finish([{ ...rejectedCoordination, input: { action: 'parallel', task: { ...task('导航'), anchorMessageIds: ['input-request'] } },
    result: { ok: true, sessionId: 'real' } }]);
  assert.equal(coordinated.work().delegationFollowUp, undefined);
});

test('A6 only a successful matching dispatch clears its obligation, not another task or a reply', async t => {
  const f = await world(t); f.finish([dispatch()]);
  f.finish([{ ...dispatch(null, '别的任务'), result: { ok: true, sessionId: 'other' } }, reply]);
  assert.equal(f.work().delegationFollowUp.blockers.length, 1);
  f.finish([{ ...dispatch(), input: { ...task('导航'), anchorMessageIds: ['input-request'] }, result: { ok: true, sessionId: 'real' } }]);
  assert.equal(f.work().delegationFollowUp, undefined);
});

test('A10 pause, cancellation, unknown effects and human waits retain priority', async t => {
  const f = await world(t); f.finish([dispatch()], { stopped: true });
  assert.equal(f.work().state, 'paused');
  f.store.saveWork({ ...f.work(), stopScope: 'work', state: 'cancelled' });
  assert.equal(f.coordination.recoverJob(), null);
});

test('A11 repeated public rewording does not count as dispatch progress', async t => {
  const f = await world(t); f.finish([dispatch(), reply]);
  f.finish([{ ...reply, input: { text: '换句话说还在处理' } }]);
  assert.equal(f.work().state, 'runnable');
  f.finish([{ ...reply, input: { text: '仍然处理' } }]);
  assert.equal(f.work().state, 'blocked_system'); assert.equal(f.work().end, 'no_progress');
});

test('A8 legacy failure adoption retains the original decision and requires explicit safe reconciliation', async t => {
  const f = await world(t);
  const original = { turnId: 'turn', failed: true, reason: 'work_disposition_required', rounds: [{ toolCalls: [reply] }] };
  const ref = f.store.checkpoint('work', { job: f.job, outcome: original });
  f.store.saveWork({ ...f.work(), state: 'blocked_system', checkpointRef: ref, intentCoordination: { goalRevision: 7, remaining: ['nav'] } });
  f.messages.push({ id: 'earlier', kind: 'agent_turn', meta: { workId: 'work' }, rounds: [{ toolCalls: [dispatch('material_out_of_scope')] }] },
    { id: 'failure', kind: 'system_card', card: 'agent_unavailable', turnId: 'turn', content: '代理暂时不可用：work_disposition_required', meta: { workId: 'work' } });
  const preserved = JSON.stringify(f.messages);
  await f.restart(); assert.equal(f.coordination.recoverJob(), null);
  assert.equal(f.work().delegationFollowUp.blockers[0].error, 'material_out_of_scope');
  const retry = f.coordination.retryJob('turn'); assert.equal(retry.ok, true);
  assert.equal(f.coordination.resume(retry.job).providerCheckpoint, undefined);
  assert.deepEqual(f.work().intentCoordination, { goalRevision: 7, remaining: ['nav'] });
  assert.equal(JSON.stringify(f.messages), preserved);
});

test('A9 crash before reply delivery preserves the dispatch blocker and the completed Tool Results', async t => {
  const f = await world(t);
  const outcome = { turnId: 'turn', rounds: [{ toolCalls: [dispatch(), reply] }] };
  f.coordination.captureDelegation(f.job, outcome);
  await f.restart(); const job = f.coordination.recoverJob(); assert.equal(job.workId, 'work');
  assert.deepEqual(f.coordination.resume(job).rounds, outcome.rounds);
});

test('A10 unknown effects cannot be made replayable by pending delegation metadata', async t => {
  const f = await world(t); f.finish([dispatch()]);
  f.store.saveWork({ ...f.work(), budget: { uncertainDispatches: [{ toolCallId: 'write', role: 'work_session' }] } });
  assert.equal(f.coordination.retryJob('turn').code, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(f.coordination.recoverJob(), null);
});

test('A10 a late reply or dispatch result cannot revive a stopped root work', async t => {
  for (const state of ['paused', 'cancelled']) {
    const f = await world(t); f.finish([dispatch()]);
    f.store.saveWork({ ...f.work(), stopScope: 'work', state });
    f.coordination.captureDelegation(f.job, { turnId: 'turn', rounds: [{ toolCalls: [dispatch('current_user_required')] }] });
    f.finish([reply]); assert.equal(f.work().state, state);
    assert.equal(f.coordination.retryJob('turn').code, 'STALE_TURN');
  }
});

test('A6/A7/A11 production Runner corrects a legacy parameter failure, keeps one reply, and admits later input', { timeout: 10000 }, async t => {
  const { createProjectAgentRunner } = await import('./runner.mjs');
  const { createDelegationProvider } = await import('./delegation-provider.mjs');
  const { createDesktopReplyComposer } = await import('./reply-composer-port.mjs');
  const f = await world(t, { start: false }); let requests = 0, spawned = 0;
  const provider = createDelegationProvider({ supervisor: { spawn: () => { spawned++; return { sessionId: 'actual', status: 'queued' }; } },
    replyComposer: createDesktopReplyComposer() });
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'parent', inbox: createProjectInbox({ rootDir: f.store.journalFile + '.inbox' }),
    coordinationStore: f.store, resolveModel: () => ({ modelProviderId: 'fixture' }), resolveRoster: () => [],
    readMessages: () => f.messages, appendMessage: (_id, msg) => f.messages.push(msg), retryDelays: [],
    executeTurn: async ({ turnProfile, streamId, plan }) => {
      requests++;
      if (plan.userInputs[0]?.inputId === 'later') return { text: '新输入正常处理' };
      const ctx = { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', conversationId: 'parent', turnProfile,
        turnId: streamId, currentInputAnchors: ['input-request'], messages: f.messages, toolCallOrdinal: 1 };
      const text = '正在修正参数并继续';
      if (requests === 1) {
        const posted = await provider.executeCapability({ call: { toolCallId: 'first-reply', capabilityId: 'local.delegation.post_reply', arguments: { text, replyTo: ['request'] } } }, ctx);
        return { toolCalls: [dispatch(), { name: 'post_reply', input: { text, replyTo: ['request'] }, result: posted.result }] };
      }
      assert.ok(turnProfile.context.delegationFollowUp.blockers.length);
      assert.equal(turnProfile.providerCheckpoint, undefined);
      const args = { ...task('导航'), kind: 'docs', successCriteria: [{ kind: 'model_review', description: 'fixture' }], requiredCapabilities: [] };
      const created = await provider.executeCapability({ call: { toolCallId: 'fixed-spawn', capabilityId: 'local.delegation.spawn_session', arguments: args } }, ctx);
      assert.equal(created.result.status, 'success');
      const posted = await provider.executeCapability({ call: { toolCallId: 'same-reply', capabilityId: 'local.delegation.post_reply', arguments: { text, replyTo: ['request'] } } }, { ...ctx, toolCallOrdinal: 2 });
      assert.equal(posted.result.output.suppressed, true);
      return { toolCalls: [{ ...dispatch(), input: args, result: created.result }, { name: 'post_reply', input: { text, replyTo: ['request'] }, result: posted.result }] };
    } });
  t.after(() => runner.dispose());
  await runner.enqueueUserInputs([input]);
  assert.equal(spawned, 1, JSON.stringify({ requests, messages: f.messages })); assert.equal(requests, 2);
  assert.equal(f.messages.filter(row => row.kind === 'agent_reply').length, 1);
  const work = Object.values(f.store.read().works).find(row => row.anchorInputIds?.includes('request'));
  assert.equal(work.delegationFollowUp, undefined);
  await runner.enqueueUserInputs([input]);
  assert.equal(requests, 2, 'the same canonical input remains owned and is never dispatched again');
  await runner.enqueueUserInputs([{ inputId: 'later', text: '独立的新问题' }]);
  assert.equal(requests, 3); assert.equal(spawned, 1);
});

test('A4/A11 later input can observe a blocked dispatch obligation without gaining admission or auto-retry', async t => {
  const f = await world(t); f.finish([dispatch('current_user_required'), reply]);
  const facts = f.coordination.delegationFacts('a-new-independent-work');
  assert.equal(facts.blockers[0].workId, 'work'); assert.equal(facts.blockers[0].workState, 'blocked_system');
  assert.equal(facts.blockers[0].retryable, false); assert.equal(f.coordination.recoverJob(), null);
});

test('A9/A10 unknown dispatch stays blocked until the durable operation and binding reconcile; then only reporting is owed', async t => {
  const f = await world(t);
  const unknown = { ...dispatch('execution_outcome_unknown'), result: { ok: false, error: 'execution_outcome_unknown', operationId: 'op' } };
  f.finish([unknown, reply]);
  assert.equal(f.coordination.retryJob('turn').code, 'EXECUTION_OUTCOME_UNKNOWN');
  const admitted = f.store.decide({ operationId: 'op', workId: 'work', expectedRevision: 0, action: 'parallel',
    sourceInputIds: ['request'], sourceEventIds: [], reason: 'actual persisted dispatch', payload: { task: task('导航') } },
  { parentConversationId: 'parent', currentInputIds: ['request'], eventIds: [], materialRefs: [] });
  assert.equal(admitted.ok, true);
  f.store.advanceTransition('op', 'recorded', { phase: 'ready' });
  assert.equal(f.coordination.recoverJob(), null, 'a recorded operation is not a created task');
  const transition = f.store.read().transitions.op;
  f.store.bindSession('work', 1, 'actual-session', { workId: 'work', sessionId: 'actual-session', goalRevision: 1, executionEpoch: transition.executionEpoch });
  f.store.advanceTransition('op', 'ready', { phase: 'started', replacementSessionId: 'actual-session' });
  f.store.advanceTransition('op', 'started', { phase: 'completed' });
  const { reconcileDelegationFollowUp } = await import('./delegation-follow-up.mjs');
  const pendingBefore = f.work().delegationFollowUp;
  for (const corrupt of [state => { state.mandates.work.goalRevision = 2; },
    state => { state.mandates.work.executionBindings['actual-session'].executionEpoch = 'stale'; },
    state => { state.decisions.op.workId = 'another-work'; }]) {
    const stale = structuredClone(f.store.read()); corrupt(stale);
    assert.equal(reconcileDelegationFollowUp(pendingBefore, stale, 'work'), pendingBefore);
  }
  const resumed = f.coordination.recoverJob(); assert.equal(resumed.workId, 'work');
  assert.equal(f.work().delegationFollowUp.blockers[0].error, 'delegation_receipt_reconciled');
  assert.equal(f.coordination.resume(resumed).providerCheckpoint, undefined);
  const report = { id: 'actual-report', kind: 'agent_reply', sources: ['actual-session'], content: '实际任务已启动', meta: {
    workId: 'work', sessionStates: [{ sessionId: 'actual-session', status: 'running', sourceRevision: 'host-current' }] } };
  const posted = { name: 'post_reply', result: { ok: true, message: report } };
  f.coordination.captureDelegation(f.job, { turnId: 'turn', rounds: [{ toolCalls: [posted] }] });
  assert.ok(f.work().delegationFollowUp, 'a successful post result alone is not canonical delivery');
  f.store.append({ kind: 'reply_prepared', message: report });
  f.store.append({ kind: 'reply_delivered', messageId: report.id });
  f.finish([posted]);
  assert.equal(f.work().delegationFollowUp, undefined);
  assert.equal(Object.keys(f.store.read().transitions).length, 1, 'reconciliation cannot redispatch');
});
