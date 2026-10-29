import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createWorkBudgetGuard, registerWorkBudget, workBudgetBinding } from './work-budget.mjs';

function fixture({ legacy = false, capabilityId = 'verify_session', state = 'blocked_system', query } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-outcome-recovery-'));
  let owned = true, epoch = 'owner', calls = 0, queries = 0;
  const options = { rootDir: root, workspaceId: 'w', holdsLease: () => owned, leaseEpoch: () => epoch };
  const store = createWorkCoordinationStore(options);
  const native = store.checkpoint('work:native', { provider: 'openai', messages: [] });
  const checkpointRef = store.checkpoint('work', { job: { workId: 'work', kind: 'wake', userInputs: [], events: [], throughSeq: 0 }, outcome: { rounds: [] } });
  const pending = { toolCallId: 'verify-1', capabilityId, attemptId: 'old', role: 'project_agent', ...(!legacy ? { verificationSessionId: 's' } : {}) };
  store.saveWork({ workId: 'work', schemaVersion: 1, workspaceId: 'w', parentConversationId: 'c', state, stopScope: 'reply',
    checkpointRef, nativeCheckpointRef: native, sessionIds: ['s'], anchorInputIds: [], pendingEventIds: [], consumedEventIds: [], waitFor: [],
    recovery: { failureKind: 'execution_outcome_unknown', retryable: false, failedTurnId: 'failed', autoAttempts: 0 },
    budget: { modelRequests: 30, toolCalls: 61, tokens: 20, costUsd: 0, attempts: {}, uncertainDispatches: [pending] } });
  const messages = legacy ? [{ id: 'old-turn', kind: 'agent_turn', meta: { workId: 'work' }, rounds: [{ toolCalls: [
    { name: 'verify_session', input: { sessionId: 's' }, result: '工具调用已中断' },
    { name: 'verify_session', input: JSON.stringify({ sessionId: 's' }), result: { ok: false, error: 'cancelled_outcome_unknown' } },
  ] }] }] : [];
  const inbox = createProjectInbox({ rootDir: root });
  const release = registerWorkBudget('w', store);
  const reconcileVerification = input => { queries++; return query ? query(input, { loseLease: () => { epoch = 'replacement'; } })
    : { status: 'inactive', ...input, planId: 'plan', sourceRevision: 'current' }; };
  let context;
  const kinds = [];
  const ports = { workspaceId: 'w', conversationId: 'c', inbox, coordinationStore: store, reconcileVerification,
    holdsLease: () => owned, readMessages: () => messages, appendMessage: (_id, row) => messages.push(row),
    resolveModel: () => ({ modelProviderId: 'm' }), retryDelays: [], executeTurn: async input => { const guard = createWorkBudgetGuard(input.turnProfile);
      try { guard.beforeRequest(); calls++; context = input.turnProfile.context; kinds.push(input.plan.kind);
        return input.plan.kind === 'user' ? { text: '新问题已答复。' } : { toolCalls: [] }; } finally { guard.finish(); } } };
  let runner = createProjectAgentRunner(ports);
  return { root, store, messages, inbox, get runner() { return runner; }, get calls() { return calls; }, get queries() { return queries; },
    get context() { return context; }, kinds, work: () => store.read().works.work,
    restart() { runner.dispose(); runner = createProjectAgentRunner({ ...ports, coordinationStore: createWorkCoordinationStore(options) }); },
    close() { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); } };
}

test('old interrupted verification is reconciled before the next session wake, without replaying the old call', async () => {
  const env = fixture({ legacy: true });
  try {
    env.inbox.append('w', [{ eventId: 'resumed', kind: 'session_running', sessionId: 's', workspaceId: 'w', at: new Date().toISOString() }]);
    await env.runner.kick();
    assert.equal(env.calls, 1);
    assert.deepEqual(env.work().budget.uncertainDispatches, []);
    assert.equal(env.work().budget.modelRequests, 31);
    assert.equal(env.work().budget.toolCalls, 61);
    assert.equal(env.work().budget.reconciledDispatches[0].outcome, 'verification_interrupted');
    assert.equal(env.context.dispatchRecovery[0].sessionId, 's');
    env.restart(); await env.runner.kick();
    assert.equal(env.queries, 1, 'durable reconciliation is idempotent after restart');
  } finally { env.close(); }
});

test('manual continue reconciles a known verification target and preserves the original work', async () => {
  const env = fixture();
  try {
    assert.equal((await env.runner.retry('failed')).ok, true);
    assert.equal(env.calls, 1);
    assert.equal(Object.keys(env.store.read().works).length, 1);
  } finally { env.close(); }
});

test('an interrupted readonly session query needs its canonical dispatch and turn, then resumes without replay', async () => {
  const env = fixture({ legacy: true, capabilityId: 'get_session' });
  try {
    env.messages[0].rounds[0].toolCalls.forEach(call => { call.name = 'get_session'; });
    await env.runner.kick();
    assert.equal(env.calls, 0, 'no original dispatch identity means no reconciliation');
    const work = env.work(), pending = work.budget.uncertainDispatches[0];
    env.store.saveWork({ ...work, attemptId: 'old-turn', budget: { ...work.budget, uncertainDispatches: [],
      attempts: { old: { role: 'project_agent', pendingTools: [pending] } } } });
    env.store.saveWork(work);
    await env.runner.kick();
    assert.equal(env.calls, 1);
    assert.deepEqual(env.work().budget.uncertainDispatches, []);
    assert.equal(env.work().budget.reconciledDispatches[0].outcome, 'query_interrupted');
    assert.equal(env.work().budget.toolCalls, 61, 'the old query is not replayed');
    assert.equal(env.context.dispatchRecovery[0].verdict, 'unconfirmed');
  } finally { env.close(); }
});

test('a query with a mismatched canonical tool name cannot release an unknown dispatch', async () => {
  const env = fixture({ legacy: true, capabilityId: 'get_session' });
  try {
    const work = env.work(), pending = work.budget.uncertainDispatches[0];
    env.store.saveWork({ ...work, attemptId: 'old-turn', budget: { ...work.budget, uncertainDispatches: [],
      attempts: { old: { role: 'project_agent', pendingTools: [pending] } } } });
    env.store.saveWork(work);
    await env.runner.kick();
    assert.equal(env.calls, 0);
    assert.equal(env.work().budget.uncertainDispatches.length, 1);
  } finally { env.close(); }
});

test('a legacy delivered receipt can reconcile an inactive local verification without replaying it',async()=>{
  const env=fixture({state:'delivered'});
  try {
    await env.runner.kick();
    assert.deepEqual(env.work().budget.uncertainDispatches,[]);
    assert.equal(env.work().budget.reconciledDispatches[0].outcome,'verification_interrupted');
    assert.equal(env.calls,0);
    assert.equal(env.work().budget.toolCalls,61);
  }finally{env.close();}
});

for (const variant of [
  { name: 'unconfirmed write', capabilityId: 'local.file.write' },
  { name: 'unavailable host', query: () => { throw Error('unreadable plan'); } },
  { name: 'asynchronous host without local proof', query: () => Promise.reject(Error('unavailable')) },
  { name: 'live verification', query: input => ({ ...input, status: 'active' }) },
  { name: 'wrong scope', query: input => ({ ...input, status: 'inactive', workspaceId: 'other' }) },
  { name: 'lost owner', query: (input, ports) => { ports.loseLease(); return { ...input, status: 'inactive', planId: 'plan', sourceRevision: 'current' }; } },
]) test(`${variant.name} cannot clear unknown outcomes or execute a model request`, async () => {
  const env = fixture(variant);
  try {
    await env.runner.kick().catch(() => {});
    assert.equal(env.calls, 0);
    assert.equal(env.work().budget.uncertainDispatches.length, 1);
  } finally { env.close(); }
});

test('reconciliation preserves an explicit paused work without automatically resuming it', async () => {
  const env = fixture({ state: 'paused' });
  try { await env.runner.kick(); assert.equal(env.work().state, 'paused'); assert.equal(env.calls, 0); }
  finally { env.close(); }
});

test('ambiguous legacy histories and assistant prose cannot discharge an old invocation', async () => {
  for (const ambiguity of ['duplicate', 'prose', 'foreign']) {
    const env = fixture({ legacy: true });
    try {
      if (ambiguity === 'duplicate') env.messages.push(structuredClone({ ...env.messages[0], id: 'other-turn' }));
      if (ambiguity === 'prose') env.messages[0].kind = 'agent_reply';
      if (ambiguity === 'foreign') env.messages[0].meta.workId = 'other-work';
      await env.runner.kick();
      assert.equal(env.work().budget.uncertainDispatches.length, 1);
      assert.equal(env.queries, 0);
      assert.equal(env.calls, 0);
    } finally { env.close(); }
  }
});

test('checkpoint loss remains blocked after a review is truthfully reconciled', async () => {
  const env = fixture();
  try {
    const work = env.work();
    rmSync(path.join(env.root, 'w', 'checkpoints', work.nativeCheckpointRef));
    await env.runner.kick();
    assert.equal(env.calls, 0);
    assert.equal(env.work().state, 'blocked_system');
    assert.equal(env.work().recovery.blockedCode, 'RECOVERY_CHECKPOINT_UNAVAILABLE');
  } finally { env.close(); }
});

test('a reconciliation write failure retains uncertainty and does not start execution', async () => {
  const env = fixture();
  const save = env.store.saveWork;
  try {
    env.store.saveWork = () => { throw Error('disk full'); };
    await assert.rejects(env.runner.kick(), /disk full/);
    assert.equal(env.calls, 0);
    assert.equal(env.work().budget.uncertainDispatches.length, 1);
  } finally { env.store.saveWork = save; env.close(); }
});

test('a write discovered during the host query is retained and prevents continuation', async () => {
  let env;
  env = fixture({ query: input => {
    const current = env.work();
    env.store.saveWork({ ...current, budget: { ...current.budget, uncertainDispatches: [...current.budget.uncertainDispatches,
      { toolCallId: 'write-2', capabilityId: 'local.file.write', attemptId: 'concurrent', role: 'project_agent' }] } });
    return { ...input, status: 'inactive', planId: 'plan', sourceRevision: 'current' };
  } });
  try {
    await env.runner.kick();
    assert.equal(env.calls, 0);
    assert.deepEqual(env.work().budget.uncertainDispatches.map(row => row.toolCallId), ['write-2']);
    assert.equal(env.work().budget.reconciledDispatches.length, 1);
  } finally { env.close(); }
});

test('new invocations retain a minimal target for reconciliation, never model supplied policy', async () => {
  const env = fixture({ state: 'runnable' });
  const current = env.work(); env.store.saveWork({ ...current, budget: { ...current.budget, uncertainDispatches: [] } });
  const release = registerWorkBudget('w', env.store);
  try {
    const guard = createWorkBudgetGuard({ workId: 'work', workspaceId: 'w', role: 'project_agent' });
    guard.beforeRequest();
    guard.beforeTool({ toolCallId: 'new', capabilityId: 'local.delegation.verify_session', arguments: { sessionId: 's', passed: true, full_local: true } });
    const pending = Object.values(env.work().budget.attempts)[0].pendingTools[0];
    assert.deepEqual(pending, { toolCallId: 'new', capabilityId: 'local.delegation.verify_session', verificationSessionId: 's' });
    guard.finish();
  } finally { release(); env.close(); }
});

test('an active dispatch is never reconciled; an orphaned attempt can close after it leaves', async () => {
  const env = fixture();
  try {
    const work = env.work(), row = work.budget.uncertainDispatches[0];
    env.store.saveWork({ ...work, budget: { ...work.budget, uncertainDispatches: [], attempts: {
      old: { role: 'project_agent', pendingTools: [row] },
    } } });
    workBudgetBinding('w').activeAttempts.add('old');
    await env.runner.kick();
    assert.equal(env.queries, 0); assert.equal(env.calls, 0);
    workBudgetBinding('w').activeAttempts.delete('old');
    await env.runner.kick();
    assert.equal(env.queries, 1); assert.equal(env.calls, 1);
    assert.deepEqual(env.work().budget.attempts.old.pendingTools, []);
  } finally { env.close(); }
});

test('two simultaneous continue requests reconcile and schedule the original work only once', async () => {
  const env = fixture();
  try {
    const result = await Promise.all([env.runner.retry('failed'), env.runner.retry('failed')]);
    assert.equal(result.every(row => row.ok), true);
    assert.equal(env.calls, 1); assert.equal(env.queries, 1);
  } finally { env.close(); }
});

test('legacy turns without work metadata require the exact dispatch-to-turn binding in the host journal', async () => {
  const env = fixture({ legacy: true });
  try {
    env.messages[0].meta = {};
    const original = env.work(), row = original.budget.uncertainDispatches[0];
    env.store.saveWork({ ...original, attemptId: 'old-turn', budget: { ...original.budget,
      uncertainDispatches: [], attempts: { old: { role: 'project_agent', pendingTools: [row] } } } });
    env.store.saveWork(original);
    await env.runner.kick();
    assert.equal(env.calls, 1);
    assert.deepEqual(env.work().budget.uncertainDispatches, []);
  } finally { env.close(); }
});

test('a live unrelated worker keeps its pending call while the interrupted parent verification resumes', async () => {
  const env = fixture();
  try {
    const work = env.work();
    env.store.saveWork({ ...work, budget: { ...work.budget, attempts: {
      child: { role: 'work_session', planId: 'child-plan', pendingTools: [{ toolCallId: 'child-write', capabilityId: 'local.file.write' }] },
    } } });
    workBudgetBinding('w').activeAttempts.add('child');
    await env.runner.kick();
    assert.equal(env.calls, 1);
    assert.equal(env.work().budget.attempts.child.pendingTools[0].toolCallId, 'child-write');
    assert.equal(workBudgetBinding('w').activeAttempts.has('child'), true);
  } finally { env.close(); }
});

test('startup continuation discovery reconciles an old review even without a new inbox event', async () => {
  const env = fixture();
  try {
    assert.equal(env.runner.hasContinuation(), true);
    await env.runner.kick();
    assert.equal(env.calls, 1);
    assert.equal(env.queries, 1);
  } finally { env.close(); }
});

test('a fresh user goal retains priority over an old system-blocked review that has just been reconciled', async () => {
  const env = fixture();
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'new-input', text: '处理新的独立问题' }]);
    assert.deepEqual(env.kinds, ['user', 'wake'], 'the new input runs before the independent recovered work');
    assert.equal(Object.keys(env.store.read().works).length, 2, 'new input never inherits the old work');
    assert.equal(env.work().state, 'delivered');
  } finally { env.close(); }
});
