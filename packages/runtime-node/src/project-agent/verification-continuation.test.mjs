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

test('restart retains original checkpoint and spent requests while renewing its slice deadline', async () => {
  const port = storage(); let first = true, clock = Date.now();
  await assert.rejects(runContinuedVerification({ identity, port, run: async ({ executionBudget }) => {
    if (first) { first = false; return slice(executionBudget, 12, 1); }
    executionBudget.guard.beforeRequest(); throw Error('transport lost');
  } }), /transport lost/);
  const deadline = port.state().deadlineAt; clock = Date.parse(deadline) + 1000;
  const result = await runContinuedVerification({ identity, port, now: () => clock, run: async ({ executionBudget }) => {
    assert.equal(executionBudget.providerCheckpoint.messages[0].content, 'paired 1');
    executionBudget.guard.beforeRequest();
    return { events: text({ passed: true, evidenceRefs: ['ev-1-0'] }) };
  } });
  assert.equal(result.passed, true); assert.ok(Date.parse(port.state().deadlineAt) > Date.parse(deadline));
  assert.equal(port.state().modelRequests, 14); assert.equal(port.state().toolCalls, 12);
});

test('format repair shares the original request allowance and cannot reset it', async () => {
  const port = storage(); let calls = 0;
  await assert.rejects(runContinuedVerification({ identity, port, limits: { maxModelRequests: 1, maxToolCalls: 20 },
    run: async ({ executionBudget }) => { calls++; executionBudget.guard.beforeRequest(); return { events: text('invalid') }; } }), { code: 'verifier_budget_limited' });
  assert.equal(calls, 1); assert.equal(port.state().modelRequests, 1);
});

test('tool uncertainty, missing checkpoint and changed model fail before dispatch', async () => {
  for (const kind of ['tools', 'missing', 'model']) {
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

test('continued useful review crosses 96 requests, 512 tools and five cumulative minutes without a total cap', async () => {
  const port = storage(); let calls = 0, clock = Date.now();
  const result = await runContinuedVerification({ identity, port, now: () => clock, run: async ({ executionBudget }) => {
    calls++;
    if (calls <= 24) {
      const result = slice(executionBudget, 12, calls);
      for (let i = 0; i < 84; i++) {
        executionBudget.guard.beforeTool();
        result.events.push({ channel: 'chat:stream:tool-call', payload: { tool: 'read_file', args: { path: `extra-${calls}-${i}` } } },
          { channel: 'chat:stream:tool-result', payload: { evidenceRefs: [`extra-${calls}-${i}`], result: { content: `new fact ${calls}-${i}` } } });
      }
      executionBudget.guard.checkpoint(result.outcome.providerCheckpoint, []);
      clock += 60_000;
      return result;
    }
    executionBudget.guard.beforeRequest();
    return { events: text({ passed: true, evidenceRefs: ['ev-1-0'] }) };
  } });
  assert.equal(result.passed, true); assert.equal(port.state().modelRequests, 289);
  assert.equal(port.state().toolCalls, 2304); assert.equal(port.state().policyVersion, 2);
});

test('alternating old observations stop review and retired slice callbacks cannot mutate later work', async () => {
  const port = storage(); let calls = 0, prior;
  await assert.rejects(runContinuedVerification({ identity, port, run: async ({ executionBudget }) => {
    if (prior) assert.throws(() => prior.beforeRequest(), { code: 'work_execution_stopped' });
    prior = executionBudget.guard;
    return slice(executionBudget, 1, ++calls % 2);
  } }), { code: 'verifier_no_progress' });
  assert.equal(calls, 4);
});

test('format repair is one request with no tools and retains indexed evidence', async () => {
  let calls = 0;
  const port = storage();
  const result = await runContinuedVerification({ identity, port, allowedEvidenceRefs: ['ev-existing'],
    run: async ({ attempt, executionBudget }) => {
      calls++;
      executionBudget.guard.beforeRequest();
      if (!attempt) return { events: text('not a structured report') };
      assert.equal(executionBudget.maxTurns, 1);
      assert.equal(executionBudget.maxToolCalls, 0);
      assert.throws(() => executionBudget.guard.beforeTool(), { code: 'verifier_report_invalid' });
      return { events: text({ passed: true, evidenceRefs: ['ev-existing'] }) };
    } });
  assert.equal(result.passed, true);
  assert.equal(calls, 2);
  assert.equal(port.state().toolCalls, 0);
});

test('recovery cannot renew ten minutes without factual progress, even with a fresh slice deadline', async () => {
  const port = storage();
  const start = Date.parse('2026-10-21T00:00:00Z');
  port.save({ schemaVersion: 1, continuationId: 'review', ...identity, policyVersion: 2,
    phase: 'ready', modelRequests: 40, toolCalls: 30, formatAttempt: 0, evidenceRefs: [],
    startedAt: new Date(start).toISOString(), lastProgressAt: new Date(start).toISOString(),
    deadlineAt: new Date(start + 60 * 60_000).toISOString() });
  await assert.rejects(runContinuedVerification({ identity, port, now: () => start + 10 * 60_000,
    run: () => assert.fail('idle review must stop before dispatch') }), { code: 'verifier_no_progress' });
});

test('paired new observations publish durable progress without treating requests as progress', async () => {
  const port = storage(); let clock = Date.parse('2026-10-21T00:00:00Z'), calls = 0;
  await runContinuedVerification({ identity, port, now: () => clock, run: async ({ executionBudget }) => {
    if (!calls++) { clock += 60_000; return slice(executionBudget, 1, 'fresh'); }
    const prior = port.state();
    assert.equal(prior.observationCount, 1);
    assert.equal(prior.lastProgressAt, new Date(clock).toISOString());
    clock += 60_000;
    executionBudget.guard.beforeRequest();
    assert.equal(port.state().lastProgressAt, prior.lastProgressAt);
    return { events: text({ passed: true, evidenceRefs: ['ev-fresh-0'] }) };
  } });
});

test('a new explicit review after a terminal report retains usage and receives its own format-repair admission', async () => {
  const port = storage(); let clock = Date.now();
  for (let run = 0; run < 2; run++) {
    let calls = 0;
    const result = await runContinuedVerification({ identity, port, now: () => clock, allowedEvidenceRefs: ['e'],
      run: async ({ attempt, executionBudget }) => {
        calls++; executionBudget.guard.beforeRequest();
        return { events: text(attempt ? { passed: true, evidenceRefs: ['e'] } : 'invalid report') };
      } });
    assert.equal(result.passed, true); assert.equal(calls, 2);
    clock += 60 * 60_000;
  }
  assert.equal(port.state().modelRequests, 4);
});
