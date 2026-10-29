import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createWorkBudgetGuard, registerWorkBudget } from './work-budget.mjs';
import { createDesktopProjectFacts } from './project-facts.mjs';

const oldLimits = { maxModelRequests: 256, maxToolCalls: 2048, source: 'system:execution-continuity-v1' };
function world(executeTurn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'progress-execution-'));
  const opts = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' };
  let store = createWorkCoordinationStore(opts), release = registerWorkBudget('w', store), policy = {};
  const messages = [], roster = [];
  const inbox = createProjectInbox({ rootDir: root });
  const ports = { workspaceId: 'w', conversationId: 'c', inbox, executeTurn, resolveRoster: () => roster,
    appendMessage: (_id, row) => messages.push(row), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'm' }), retryDelays: [] };
  let runner = createProjectAgentRunner({ ...ports, coordinationStore: store });
  const facts = createDesktopProjectFacts({ runtimeRoot: root, supervisor: { sessionsForProject: () => roster, acceptance: () => null },
    approvalStore: { list: () => [] }, profileStore: { read: () => ({ agentConversationId: 'c' }) },
    conversationStore: { getPersistedConversationHistory: () => ({ messages }) }, readCoordination: () => store.read() });
  return { root, messages, roster, facts, get runner() { return runner; }, get store() { return store; },
    work: () => Object.values(store.read().works)[0],
    setPolicy(value) { policy = value; release(); release = registerWorkBudget('w', store, policy); },
    restart() { runner.dispose(); release(); store = createWorkCoordinationStore(opts); release = registerWorkBudget('w', store, policy);
      runner = createProjectAgentRunner({ ...ports, coordinationStore: store }); },
    close() { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); } };
}

test('a production runner crosses 256 requests and 2048 paired tools, restarts and delivers once', async () => {
  let requests = 0; const executed = new Set();
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try {
      if (requests) assert.equal(turnProfile.providerCheckpoint.index, requests);
      guard.beforeRequest({ accounting: 'physical_dispatch' }); requests++;
      if (requests > 300) return { text: '核对完成，全部结果已保留。' };
      const calls = Array.from({ length: 7 }, (_, i) => {
        const id = `read-${requests}-${i}`;
        assert.equal(executed.has(id), false); executed.add(id);
        guard.beforeTool({ toolCallId: id, capabilityId: 'local.file.read' });
        return { toolCallId: id, name: 'read_file', input: { path: `${requests}-${i}.txt` }, result: { ok: true, text: `fact ${requests}-${i}` } };
      });
      const native = { index: requests, messages: calls.map(call => ({ role: 'tool', tool_call_id: call.toolCallId, content: call.result.text })) };
      guard.checkpoint(native, calls.map(call => ({ call, result: call.result })));
      return { turnEnd: 'yielded', toolCalls: calls, providerCheckpoint: native };
    } finally { guard.finish({ totalTokens: 1, estimatedCostUsd: 0 }); }
  });
  try {
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '核对完整结果' }]);
    for (let i = 0; i < 310 && env.work().state !== 'delivered'; i++) {
      if (i === 149) env.restart();
      await env.runner.kick();
    }
    assert.equal(env.work().state, 'delivered'); assert.equal(requests, 301);
    assert.equal(env.work().budget.modelRequests, 301); assert.equal(env.work().budget.toolCalls, 2100);
    assert.equal(executed.size, 2100); assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
    assert.equal(env.messages.some(row => row.card === 'agent_unavailable'), false);
  } finally { env.close(); }
});

async function seedStopped(env, patch = {}) {
  await env.runner.enqueueUserInputs([{ inputId: 'i', text: '继续原来的工作' }]);
  const work = env.work();
  env.store.saveWork({ ...work, state: 'budget_limited', end: 'budget_limited',
    recovery: { failureKind: 'budget_exhausted', retryable: false, autoAttempts: 0, failedTurnId: work.attemptId },
    budget: { ...work.budget, modelRequests: 256, toolCalls: 468, limits: oldLimits }, ...patch });
  return env.work();
}
const yielded = { turnEnd: 'yielded', toolCalls: [{ name: 'read_file', input: { path: 'done.txt' }, result: { text: 'already read' } }],
  providerCheckpoint: { index: 1, messages: [{ role: 'tool', content: 'already read' }] } };

test('an obsolete system stop automatically resumes its safe native checkpoint and keeps usage and audit', async () => {
  let calls = 0;
  const env = world(async ({ turnProfile }) => {
    if (++calls === 1) return yielded;
    assert.equal(turnProfile.providerCheckpoint.messages[0].content, 'already read');
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest(); return { text: '已有结果已核对并交付。' }; } finally { guard.finish(); }
  });
  try {
    await seedStopped(env); env.restart(); await env.runner.kick();
    assert.equal(calls, 2); assert.equal(env.work().state, 'delivered');
    assert.equal(env.work().budget.modelRequests, 257); assert.equal(env.work().budget.toolCalls, 468);
    assert.deepEqual(env.work().budget.policyMigration.previousLimits, oldLimits);
    env.restart(); await env.runner.kick(); assert.equal(calls, 2, 'migration and delivery cannot replay');
  } finally { env.close(); }
});

test('legacy recovery never releases explicit budgets, cancellation, pause, user waits or unsafe dispatches', async () => {
  for (const kind of ['explicit', 'different', 'cost', 'unknown-source', 'cancelled', 'paused', 'unknown', 'missing', 'human']) {
    let calls = 0; const env = world(async () => { calls++; return yielded; });
    try {
      let work = await seedStopped(env);
      if (kind === 'explicit') env.setPolicy({ maxModelRequests: 256 });
      if (kind === 'different') work.budget.limits = { ...oldLimits, maxModelRequests: 100 };
      if (kind === 'cost') work.budget.limits = { ...oldLimits, maxCostUsd: 10 };
      if (kind === 'unknown-source') work.budget.limits = { ...oldLimits, source: 'legacy:unknown' };
      if (['cancelled', 'paused'].includes(kind)) work.state = kind;
      if (kind === 'unknown') work.budget.uncertainDispatches = [{ toolCallId: 'write', role: 'work_session' }];
      if (kind === 'missing') work.nativeCheckpointRef = 'a'.repeat(64) + '.json';
      if (kind === 'human') { work.sessionIds = ['s']; env.roster.push({ sessionId: 's', status: 'waiting_user' }); }
      env.store.saveWork(work); env.restart(); await env.runner.kick();
      assert.equal(calls, 1, kind); assert.equal(env.work().budget.policyMigration, undefined, kind);
      assert.equal(env.work().budget.modelRequests, 256);
    } finally { env.close(); }
  }
});

test('host projection and retry admission agree on a real exhausted explicit limit', async () => {
  let calls = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest(); calls++; return { text: 'should not run' }; } finally { guard.finish(); }
  });
  try {
    env.setPolicy({ maxModelRequests: 0 });
    await env.runner.enqueueUserInputs([{ inputId: 'i', text: '检查' }]);
    const card = env.facts.cards('w').find(row => row.kind === 'agent_unavailable');
    assert.equal(card.recoveryAction.canContinue, false); assert.equal(card.recoveryAction.budget.limit, 0);
    assert.deepEqual(card.actions, []); assert.equal(calls, 0);
    assert.deepEqual(await env.runner.retry(env.work().attemptId), { ok: false, code: 'WORK_BUDGET_EXHAUSTED' });
    env.setPolicy({ maxModelRequests: 2 });
    assert.equal(env.facts.cards('w').find(row => row.kind === 'agent_unavailable').recoveryAction.canContinue, true);
    assert.equal((await env.runner.retry(env.work().attemptId)).ok, true); assert.equal(calls, 1);
  } finally { env.close(); }
});
