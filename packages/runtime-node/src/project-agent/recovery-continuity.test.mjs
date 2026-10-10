import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createWorkBudgetGuard, registerWorkBudget } from './work-budget.mjs';
import { createRuntimePipeline } from '@peer-agent/runtime-sdk';

function world(executeTurn, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-request-recovery-'));
  let clock = Date.parse('2026-10-10T06:00:00Z');
  let owned = true;
  const now = () => new Date(clock).toISOString();
  const options = { rootDir: root, workspaceId: 'w', holdsLease: () => owned, leaseEpoch: () => 'owner', now };
  let store = createWorkCoordinationStore(options);
  const inbox = createProjectInbox({ rootDir: root, now });
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const ports = { workspaceId: 'w', conversationId: 'c', inbox, executeTurn,
    appendMessage: (_id, message) => messages.push(message), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'm' }), holdsLease: () => owned,
    now, retryDelays: [], schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearSchedule: id => timers.delete(id), ...extra };
  let budgetPolicy = extra.workBudget || {};
  let release = registerWorkBudget('w', store, budgetPolicy);
  let runner = createProjectAgentRunner({ ...ports, coordinationStore: store });
  return { messages, get store() { return store; }, get runner() { return runner; },
    work: () => Object.values(store.read().works)[0],
    loseLease: () => { owned = false; },
    async advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); await timer.fn(); } },
    setBudget(policy) { release(); budgetPolicy = policy; release = registerWorkBudget('w', store, budgetPolicy); },
    restart() { runner.dispose(); release(); store = createWorkCoordinationStore(options); release = registerWorkBudget('w', store, budgetPolicy); runner = createProjectAgentRunner({ ...ports, coordinationStore: store }); },
    close() { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); } };
}
const input = id => ({ inputId: id, text: id });
const timeout = { ok: false, error: 'connect timeout after 20000ms (ConnectTimeoutError)', retryable: false,
  providerRecovery: { kind: 'response_headers_timeout', retryable: true, exhausted: true, attempts: 4 } };

test('a timeout after nineteen completed tools automatically resumes native results exactly once', async () => {
  let requests = 0, tools = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try {
      guard.beforeRequest({ accounting: 'physical_dispatch' });
      if (++requests === 1) {
        const results = [];
        for (let n = 0; n < 19; n++) { guard.beforeTool({ toolCallId: `read-${n}`, capabilityId: 'read_file' }); tools++; results.push({ role: 'tool', tool_call_id: `read-${n}`, content: `result-${n}` }); }
        guard.checkpoint({ provider: 'openai', providerId: 'm', model: 'model', messages: results },
          results.map(row => ({ call: { toolCallId: row.tool_call_id }, result: { output: row.content } })));
        return { ...timeout, toolCalls: results.map((row, n) => ({ name: 'read_file', input: { path: `${n}` }, result: row.content })) };
      }
      assert.equal(turnProfile.providerCheckpoint.messages.length, 19);
      return { text: '已完成。' };
    } finally { guard.finish(); }
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    assert.equal(env.work().state, 'retry_wait');
    assert.ok(env.work().recovery?.reservationId);
    await env.advance(2000);
    assert.equal(requests, 2); assert.equal(tools, 19);
    assert.equal(env.work().state, 'delivered');
    assert.equal(env.runner.status(), 'idle'); assert.equal(env.runner.parked(), null);
    assert.equal(env.messages.filter(row => row.kind === 'agent_reply').length, 1);
  } finally { env.close(); }
});

test('automatic attempts are bounded and restart preserves the same reservation and deadline', async () => {
  let requests = 0;
  const env = world(async () => { requests++; return timeout; });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const first = { ...env.work().recovery };
    env.restart();
    assert.equal(env.work().recovery.reservationId, first.reservationId);
    await env.advance(1999); assert.equal(requests, 1);
    await env.advance(1); assert.equal(requests, 2);
    assert.equal(env.work().recovery.autoAttempts, 1);
    assert.equal(env.work().recovery.deadlineAt, first.deadlineAt);
    await env.advance(5000); assert.equal(requests, 3);
    assert.equal(env.work().state, 'blocked_system');
    assert.equal(env.work().recovery.autoAttempts, 2);
    assert.equal(env.work().recovery.retryAt, undefined);
    await env.advance(300000); await env.runner.kick(); assert.equal(requests, 3);
  } finally { env.close(); }
});

test('new user input takes priority, has no old checkpoint, and invalidates the older retry', async () => {
  const seen = [];
  const env = world(async ({ plan, turnProfile }) => {
    seen.push(plan.userInputs[0].inputId);
    if (seen.length === 1) return timeout;
    assert.equal(turnProfile.providerCheckpoint, undefined);
    assert.equal(turnProfile.context?.retryContinuity, undefined);
    return { text: '新问题已回答。' };
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    await env.runner.enqueueUserInputs([input('two')]);
    assert.deepEqual(seen, ['one', 'two']);
    assert.equal(Object.values(env.store.read().works).find(work => work.anchorInputIds.includes('one')).state, 'paused');
    await env.advance(2000); assert.deepEqual(seen, ['one', 'two']);
  } finally { env.close(); }
});

test('manual retry after restart uses the durable work and does not reset budget', async () => {
  let requests = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest({ accounting: 'physical_dispatch' }); return ++requests === 1 ? timeout : { text: '恢复了。' }; }
    finally { guard.finish(); }
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const turnId = env.work().recovery.failedTurnId;
    env.restart();
    assert.equal((await env.runner.retry(turnId))?.ok, true);
    assert.equal(requests, 2); assert.equal(env.work().budget.modelRequests, 2);
    await env.advance(5000); assert.equal(requests, 2);
  } finally { env.close(); }
});

test('unknown writes remain blocked after restart and through manual retry', async () => {
  let requests = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest(); requests++; guard.beforeTool({ toolCallId: 'write', capabilityId: 'write_file' }); return timeout; }
    finally { guard.finish(); }
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const turnId = env.work().recovery.failedTurnId;
    assert.equal(env.work().recovery.failureKind, 'execution_outcome_unknown');
    env.restart();
    assert.deepEqual(await env.runner.retry(turnId), { ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' });
    await env.advance(300000); assert.equal(requests, 1);
    assert.equal(env.work().budget.uncertainDispatches.length, 1);
  } finally { env.close(); }
});

test('checkpoint failure blocks the same attempt before another model dispatch', () => {
  const env = world(async () => ({}));
  env.store.saveWork({ workId: 'work', state: 'runnable' });
  const guard = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
  try {
    guard.beforeRequest(); guard.beforeTool({ toolCallId: 'write', capabilityId: 'write_file' });
    env.store.checkpoint = () => { throw Error('disk full'); };
    assert.throws(() => guard.checkpoint({ messages: [] }), /disk full/);
    assert.throws(() => guard.beforeRequest(), /execution_outcome_unknown/);
    assert.equal(env.work().budget.modelRequests, 1);
  } finally { guard.finish(); env.close(); }
});

test('physical dispatch accounting does not add logical provider request totals again', () => {
  const env = world(async () => ({})); env.store.saveWork({ workId: 'work', state: 'runnable' });
  const guard = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
  try { guard.beforeRequest({ accounting: 'physical_dispatch' }); guard.finish({ providerRequestCount: 9 }); assert.equal(env.work().budget.modelRequests, 1); }
  finally { env.close(); }
});

test('lease loss and a stopped work invalidate an automatic reservation', async () => {
  for (const kind of ['lease', 'cancelled', 'paused', 'budget_limited']) {
    let requests = 0; const env = world(async () => { requests++; return timeout; });
    try {
      await env.runner.enqueueUserInputs([input('one')]);
      if (kind === 'lease') env.loseLease(); else env.store.saveWork({ ...env.work(), state: kind });
      await env.advance(2000); assert.equal(requests, 1, kind);
    } finally { env.close(); }
  }
});

test('partial current requests do not get replayed by the outer work recovery layer', async () => {
  let requests = 0;
  const env = world(async () => { requests++; return { ...timeout, text: '已经公开的半句话',
    providerRecovery: { kind: 'stream_interrupted', replaySafe: false, retryable: true } }; });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    assert.equal(env.work().state, 'blocked_system');
    assert.equal(env.work().recovery.retryable, false);
    await env.advance(300000); assert.equal(requests, 1);
  } finally { env.close(); }
});

test('late timers expire after five minutes without issuing a model request', async () => {
  let requests = 0; const env = world(async () => { requests++; return timeout; });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    await env.advance(300000);
    assert.equal(requests, 1); assert.equal(env.work().state, 'blocked_system');
    assert.equal(env.work().recovery.reservationId, undefined);
  } finally { env.close(); }
});

test('manual retry competes with a due timer through one revision-bound attempt', async () => {
  let requests = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const env = world(async () => ++requests === 1 ? timeout : pending);
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const turnId = env.work().recovery.failedTurnId;
    const first = env.runner.retry(turnId);
    await Promise.resolve();
    const second = env.runner.retry(turnId);
    const timer = env.advance(2000);
    resolve({ text: '恢复成功。' });
    await Promise.all([first, second, timer]);
    assert.equal(requests, 2);
    assert.equal(env.work().state, 'delivered');
  } finally { env.close(); }
});

test('a completed tool without native history hands off instead of replaying investigation', async () => {
  let requests = 0;
  const env = world(async () => { requests++; return { ...timeout, toolCalls: [{ name: 'read_file', result: 'complete' }] }; });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const turnId = env.work().recovery.failedTurnId;
    assert.deepEqual(await env.runner.retry(turnId), { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' });
    await env.advance(2000);
    assert.equal(requests, 1); assert.equal(env.work().state, 'blocked_system');
    assert.deepEqual(await env.runner.retry(turnId), { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' });
    assert.equal(env.store.readCheckpoint(env.work().checkpointRef).outcome.rounds[0].toolCalls[0].result, 'complete');
  } finally { env.close(); }
});

test('manual budget recovery requires increased host limits and keeps previous dispatch counts', async () => {
  let requests = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest({ accounting: 'physical_dispatch' }); return ++requests === 1 ? timeout : { text: '已恢复。' }; }
    finally { guard.finish({ totalTokens: 2, estimatedCostUsd: 0 }); }
  }, { workBudget: { maxModelRequests: 1 } });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    await env.advance(2000);
    assert.equal(env.work().state, 'budget_limited');
    const turnId = env.work().recovery.failedTurnId;
    assert.deepEqual(await env.runner.retry(turnId), { ok: false, code: 'WORK_BUDGET_EXHAUSTED' });
    env.setBudget({ maxModelRequests: 2 });
    assert.equal((await env.runner.retry(turnId)).ok, true);
    assert.equal(requests, 2); assert.equal(env.work().budget.modelRequests, 2);
    assert.equal(env.work().budget.tokens, 4);
  } finally { env.close(); }
});

test('increased token limits cannot resume a work with unknown token usage', async () => {
  let requests = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try { guard.beforeRequest(); requests++; return timeout; }
    finally { guard.finish(); }
  }, { workBudget: { maxTokens: 10 } });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    await env.advance(2000);
    assert.equal(env.work().state, 'budget_limited');
    assert.equal(env.work().budget.unknownUsage, true);
    env.setBudget({ maxTokens: 100 });
    assert.deepEqual(await env.runner.retry(env.work().recovery.failedTurnId), { ok: false, code: 'WORK_BUDGET_EXHAUSTED' });
    assert.equal(requests, 1); assert.equal(env.work().budget.modelRequests, 1);
  } finally { env.close(); }
});

test('non-retryable structured failures persist fatal rather than provider retryable ends', async () => {
  for (const kind of ['authentication', 'invalid_request', 'execution_outcome_unknown']) {
    const env = world(async () => ({ ok: false, error: 'opaque diagnostic', providerRecovery: { kind, retryable: false } }));
    try {
      await env.runner.enqueueUserInputs([input('one')]);
      assert.equal(env.work().recovery.failureKind, kind);
      assert.equal(env.work().end, 'fatal');
      assert.equal(env.work().recovery.reservationId, undefined);
    } finally { env.close(); }
  }
});

test('a live child dispatch is not an unknown parent result, but restart invalidates that retry', async () => {
  for (const restart of [false, true]) {
    let requests = 0, child;
    const env = world(async ({ turnProfile }) => {
      requests++;
      if (requests === 1) {
        child = createWorkBudgetGuard({ ...turnProfile, role: 'work_session' });
        child.beforeRequest(); child.beforeTool({ toolCallId: 'child-write', capabilityId: 'write_file' });
        return timeout;
      }
      return { text: '已继续。' };
    });
    try {
      await env.runner.enqueueUserInputs([input('one')]);
      assert.equal(env.work().recovery.failureKind, 'response_headers_timeout');
      assert.equal(env.work().state, 'retry_wait');
      if (restart) env.restart();
      await env.advance(2000);
      if (restart) {
        assert.equal(requests, 1);
        assert.equal(env.work().state, 'blocked_system');
        assert.equal(env.work().recovery.failureKind, 'execution_outcome_unknown');
        assert.equal(env.work().recovery.reservationId, undefined);
        assert.deepEqual(await env.runner.retry(env.work().recovery.failedTurnId), { ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' });
      } else assert.equal(requests, 2);
    } finally { child?.finish(); env.close(); }
  }
});

test('a user input queued from the final idle callback starts without waiting for a sweep', async () => {
  const seen = [];
  let queued = false;
  const env = world(async ({ plan }) => { seen.push(plan.userInputs[0].inputId); return { text: '完成。' }; }, {
    onStatus(status) {
      if (status === 'idle' && !queued) { queued = true; void env.runner.enqueueUserInputs([input('two')]); }
    },
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    assert.deepEqual(seen, ['one', 'two']);
    assert.equal(env.runner.mailbox().userInputs.length, 0);
  } finally { env.close(); }
});

test('a missing protected native checkpoint rejects manual recovery and clears automatic reservations', async () => {
  let requests = 0;
  const env = world(async ({ turnProfile }) => {
    const guard = createWorkBudgetGuard(turnProfile);
    try {
      guard.beforeRequest(); requests++; guard.beforeTool({ toolCallId: 'read', capabilityId: 'read_file' });
      guard.checkpoint({ provider: 'openai', messages: [{ role: 'tool', content: 'finished' }] },
        [{ call: { toolCallId: 'read' }, result: { output: 'finished' } }]);
      return { ...timeout, toolCalls: [{ name: 'read_file', result: 'finished' }] };
    } finally { guard.finish(); }
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const native = env.work().nativeCheckpointRef, read = env.store.readCheckpoint;
    env.store.readCheckpoint = ref => { if (ref === native) throw Object.assign(Error('missing checkpoint'), { code: 'ENOENT' }); return read(ref); };
    assert.deepEqual(await env.runner.retry(env.work().recovery.failedTurnId), { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' });
    await env.advance(2000);
    assert.equal(requests, 1); assert.equal(env.work().state, 'blocked_system');
    assert.equal(env.work().recovery.reservationId, undefined);
    assert.deepEqual(await env.runner.retry(env.work().recovery.failedTurnId), { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' });
    assert.equal(env.store.readCheckpoint(env.work().checkpointRef).outcome.rounds[0].toolCalls[0].result, 'finished');
  } finally { env.close(); }
});

test('a committed unknown ToolExecution never clears its dispatch or permits a request after restart', async () => {
  const env = world(async () => ({}));
  env.store.saveWork({ workId: 'work', workspaceId: 'w', state: 'runnable' });
  const guard = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
  const call = { toolCallId: 'write', capabilityId: 'write_file', name: 'write_file' };
  try {
    const result = await createRuntimePipeline({ model: {
      initialize: () => ({ messages: [] }),
      runTurn: state => { guard.beforeRequest(); return { kind: 'tool_calls', state, calls: [call] }; },
      applyToolResults: (state, executions) => ({ messages: executions.map(execution => execution.result) }),
      checkpoint: (state, executions) => guard.checkpoint({ provider: 'openai', messages: state.messages }, executions),
    }, tools: {
      execute: pending => { guard.beforeTool(pending); throw Error('the dispatch lost its acknowledgement'); },
      notExecuted: (pending, reason) => ({ call: pending, result: { output: JSON.stringify({ ok: false, status: 'not_executed', error: reason }), isError: true, error: reason },
        terminal: true, terminalReason: reason }),
    } }).run({ sessionId: 'session', input: null });
    assert.equal(result.reason, 'execution_outcome_unknown');
    assert.throws(() => guard.beforeRequest(), /execution_outcome_unknown/);
    guard.finish();
    assert.equal(env.work().budget.uncertainDispatches[0].toolCallId, 'write');
    env.restart();
    const restored = createWorkBudgetGuard({ workspaceId: 'w', workId: 'work', role: 'project_agent' });
    try { assert.throws(() => restored.beforeRequest(), /execution_outcome_unknown/); }
    finally { restored.finish(); }
    assert.equal(env.work().budget.modelRequests, 1); assert.equal(env.work().budget.toolCalls, 1);
  } finally { guard.finish(); env.close(); }
});

test('a queued manual retry invalidated by new input never reports the other work as its success', async () => {
  let requests = 0, release, entered;
  const busy = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const seen = [];
  const env = world(async ({ plan }) => {
    seen.push(plan.userInputs[0].inputId);
    if (++requests === 1) return timeout;
    if (requests === 2) { entered(); return busy; }
    return { text: '新问题已回答。' };
  });
  try {
    await env.runner.enqueueUserInputs([input('one')]);
    const old = env.work().recovery.failedTurnId;
    const processing = env.runner.enqueueUserInputs([input('busy')]);
    await started;
    const retry = env.runner.retry(old);
    const newer = env.runner.enqueueUserInputs([input('new')]);
    release({ text: '当前工作结束。' });
    await Promise.all([processing, newer]);
    assert.deepEqual(await retry, { ok: false, code: 'STALE_TURN' });
    assert.deepEqual(seen, ['one', 'busy', 'new']);
  } finally { release?.({ text: '结束。' }); env.close(); }
});

test('corrupt main or native checkpoints and a resume read race preserve the original history', async () => {
  for (const kind of ['main', 'native', 'resume-race']) {
    let requests = 0;
    const env = world(async ({ turnProfile }) => {
      const guard = createWorkBudgetGuard(turnProfile);
      try {
        guard.beforeRequest(); requests++; guard.beforeTool({ toolCallId: 'read', capabilityId: 'read_file' });
        guard.checkpoint({ provider: 'openai', messages: [{ role: 'tool', content: 'finished' }] },
          [{ call: { toolCallId: 'read' }, result: { output: 'finished' } }]);
        return { ...timeout, toolCalls: [{ name: 'read_file', result: 'finished' }] };
      } finally { guard.finish(); }
    });
    try {
      await env.runner.enqueueUserInputs([input('one')]);
      const old = env.work(), read = env.store.readCheckpoint;
      let nativeReads = 0;
      env.store.readCheckpoint = ref => {
        if (ref === old.nativeCheckpointRef) nativeReads++;
        if (kind === 'main' && ref === old.checkpointRef || kind === 'native' && ref === old.nativeCheckpointRef
          || kind === 'resume-race' && ref === old.nativeCheckpointRef && nativeReads >= 2) throw new SyntaxError('damaged checkpoint');
        return read(ref);
      };
      await env.advance(2000);
      assert.equal(requests, 1, kind);
      assert.equal(env.work().state, 'blocked_system', kind);
      assert.equal(env.work().checkpointRef, old.checkpointRef, kind);
      assert.equal(read(old.checkpointRef).outcome.rounds[0].toolCalls[0].result, 'finished', kind);
      assert.deepEqual(await env.runner.retry(env.work().recovery.failedTurnId), { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' }, kind);
      assert.equal(env.work().budget.modelRequests, 1); assert.equal(env.work().budget.toolCalls, 1);
    } finally { env.close(); }
  }
});

test('a stopped parent reply can explicitly continue while its child runs, but a cancelled work cannot', async () => {
  for (const cancelled of [false, true]) {
    let requests = 0, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const env = world(async ({ signal }) => {
      if (++requests === 1) { entered(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ text: '已有进展。' }), { once: true })); }
      return { text: '接着处理。' };
    }, { resolveRoster: () => [{ sessionId: 'child', status: 'running', sourceRevision: 'r1', origin: { anchorMessageId: 'input-one' } }] });
    try {
      const pending = env.runner.enqueueUserInputs([input('one')]);
      await started;
      const turnId = env.runner.activity().turnId;
      assert.equal(env.runner.stopResponse(turnId).ok, true);
      await pending;
      assert.equal(env.work().state, 'waiting_children');
      assert.equal(env.store.readCheckpoint(env.work().checkpointRef).outcome.stopped, true);
      if (cancelled) env.store.saveWork({ ...env.work(), state: 'cancelled', stopScope: 'work' });
      const result = await env.runner.retryStopped(turnId);
      assert.equal(result.ok, !cancelled);
      assert.equal(requests, cancelled ? 1 : 2);
    } finally { env.close(); }
  }
});
