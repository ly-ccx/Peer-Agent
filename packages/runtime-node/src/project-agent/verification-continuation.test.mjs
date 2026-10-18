import test from 'node:test';
import assert from 'node:assert/strict';
import { runContinuedVerification } from './verification-continuation.mjs';

const identity = { planId: 'p', sourceRevision: 'source', modelKey: 'model' };
const text = value => [{ channel: 'chat:stream:delta', payload: { content: JSON.stringify(value) } }];
function storage() {
  let state = null;
  const checkpoints = new Map();
  return { load: () => structuredClone(state), save: value => { state = structuredClone(value); },
    readCheckpoint: ref => checkpoints.get(ref), writeCheckpoint: value => { const id = `${checkpoints.size}`; checkpoints.set(id, structuredClone(value)); return id; },
    assertCurrent() {}, state: () => state, checkpoints };
}
function slice(budget, count, index) {
  const events = [];
  for (let i = 0; i < count; i++) {
    budget.guard.beforeRequest(); budget.guard.beforeTool();
    events.push({ channel: 'chat:stream:tool-call', payload: { tool: 'read_file', args: { path: `file-${index}-${i}` } } },
      { channel: 'chat:stream:tool-result', payload: { evidenceRefs: [`ev-${index}-${i}`], result: { content: `finding ${index}-${i}` } } });
  }
  const native = { provider: 'controlled', turns: count, messages: [{ role: 'tool', content: `paired ${index}` }] };
  budget.guard.checkpoint(native, []);
  return { events, outcome: { terminalStatus: 'done', turnEnd: 'yielded', providerCheckpoint: native } };
}

test('a review crosses 12 turns with paired context and may cite real evidence from the first slice', async () => {
  const port = storage(); let calls = 0;
  const result = await runContinuedVerification({ identity, port, run: async ({ executionBudget }) => {
    calls++;
    if (calls === 1) return slice(executionBudget, 12, 1);
    assert.equal(executionBudget.providerCheckpoint.messages[0].content, `paired ${calls - 1}`);
    if (calls === 2) return slice(executionBudget, 12, 2);
    executionBudget.guard.beforeRequest();
    return { events: text({ passed: true, evidenceRefs: ['ev-1-0'] }) };
  } });
  assert.equal(result.passed, true); assert.equal(calls, 3);
  assert.equal(port.state().modelRequests, 25); assert.equal(port.state().toolCalls, 24);
});

test('restart retains original checkpoint, deadline and spent requests without repeating completed tools', async () => {
  const port = storage(); let first = true;
  await assert.rejects(runContinuedVerification({ identity, port, run: async ({ executionBudget }) => {
    if (first) { first = false; return slice(executionBudget, 12, 1); }
    executionBudget.guard.beforeRequest(); throw Error('transport lost');
  } }), /transport lost/);
  const deadline = port.state().deadlineAt;
  const result = await runContinuedVerification({ identity, port, run: async ({ executionBudget }) => {
    assert.equal(executionBudget.providerCheckpoint.messages[0].content, 'paired 1');
    executionBudget.guard.beforeRequest();
    return { events: text({ passed: true, evidenceRefs: ['ev-1-0'] }) };
  } });
  assert.equal(result.passed, true); assert.equal(port.state().deadlineAt, deadline);
  assert.equal(port.state().modelRequests, 14); assert.equal(port.state().toolCalls, 12);
});

test('format repair shares the original request allowance and cannot reset it', async () => {
  const port = storage(); let calls = 0;
  await assert.rejects(runContinuedVerification({ identity, port, limits: { maxModelRequests: 1, maxToolCalls: 20 },
    run: async ({ executionBudget }) => { calls++; executionBudget.guard.beforeRequest(); return { events: text('invalid') }; } }), { code: 'verifier_budget_limited' });
  assert.equal(calls, 1); assert.equal(port.state().modelRequests, 1);
});

test('tool uncertainty, missing checkpoint, changed model and expired deadline fail before dispatch', async () => {
  for (const kind of ['tools', 'missing', 'model', 'deadline']) {
    const port = storage();
    port.save({ schemaVersion: 1, continuationId: 'id', ...identity, modelRequests: 12, toolCalls: 12,
      formatAttempt: 0, evidenceRefs: [], phase: kind === 'tools' ? 'tools' : 'ready',
      modelKey: kind === 'model' ? 'other' : identity.modelKey,
      deadlineAt: new Date(Date.now() + (kind === 'deadline' ? -1000 : 10000)).toISOString(),
      ...(kind === 'missing' ? { checkpointRef: 'lost' } : {}) });
    let calls = 0;
    await assert.rejects(runContinuedVerification({ identity, port, run: () => { calls++; } }));
    assert.equal(calls, 0, kind);
  }
});

test('cancel, timeout and denied results stop immediately and reject late continuation reservations', async () => {
  for (const kind of ['cancel', 'timeout', 'denied']) {
    const controller = new AbortController(); let ready, guard;
    const started = new Promise(resolve => { ready = resolve; });
    const pending = runContinuedVerification({ identity, signal: controller.signal, timeoutMs: 30,
      run: ({ executionBudget, onToolResult }) => { guard = executionBudget.guard; guard.beforeRequest(); ready();
        if (kind === 'denied') onToolResult({ status: 'denied' });
        return new Promise(() => {}); } });
    const rejected = assert.rejects(pending, { code: kind === 'cancel' ? 'verifier_cancelled' : kind === 'timeout' ? 'verifier_timeout' : 'verifier_permission_denied' });
    await started;
    if (kind === 'cancel') controller.abort();
    await rejected; assert.throws(() => guard.beforeRequest());
  }
});

test('checkpoint persistence failure stops the review; concurrent calls cannot take the same review', async () => {
  let ready, finish;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = runContinuedVerification({ identity, run: () => { ready(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  await assert.rejects(runContinuedVerification({ identity, run: () => assert.fail() }), { code: 'verifier_in_progress' });
  finish({ events: text({ passed: false, risks: ['specific issue'] }) }); await pending;
  const port = storage(); port.writeCheckpoint = () => { throw Error('disk full'); };
  await assert.rejects(runContinuedVerification({ identity, port, run: ({ executionBudget }) => slice(executionBudget, 1, 1) }), /disk full/);
  assert.equal(port.state().phase, 'tools');
});
