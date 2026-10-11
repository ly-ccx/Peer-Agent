import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedVerification, isVerificationTurn, verificationExecutionBudget } from './verifier-lifecycle.mjs';
import { runVerifierWithReport } from './verifier-report.mjs';

const report = { passed: true, evidenceRefs: ['real'] };
const events = content => [{ channel: 'chat:stream:delta', payload: { content } },
  { channel: 'chat:stream:done', payload: {} }];
const flush = () => new Promise(resolve => setImmediate(resolve));

test('unresponsive readonly verification times out, aborts its adapter and ignores a late pass', async () => {
  let finish, childSignal;
  const pending = runVerifierWithReport({ timeoutMs: 20, allowedEvidenceRefs: ['real'],
    run: ({ signal }) => { childSignal = signal; return new Promise(resolve => { finish = resolve; }); } });
  await assert.rejects(pending, { name: 'TimeoutError', code: 'verifier_timeout' });
  assert.equal(childSignal.aborted, true);
  finish({ events: events(JSON.stringify(report)) });
  await flush();
  await assert.rejects(pending, { code: 'verifier_timeout' });
});

test('parent cancellation promptly settles even when the adapter ignores its signal', async () => {
  const controller = new AbortController();
  let started, childSignal;
  const invoked = new Promise(resolve => { started = resolve; });
  const pending = runVerifierWithReport({ signal: controller.signal, run: ({ signal }) => {
    childSignal = signal; started(); return new Promise(() => {});
  } });
  const rejection = assert.rejects(pending, { name: 'AbortError', code: 'verifier_cancelled' });
  await invoked;
  controller.abort();
  await rejection;
  assert.equal(childSignal.aborted, true);
  let calls = 0;
  await assert.rejects(runBoundedVerification({ signal: controller.signal, run: () => calls++ }), { code: 'verifier_cancelled' });
  assert.equal(calls, 0);
});

test('format recovery shares the original overall deadline', async () => {
  const controller = new AbortController();
  let signalSeen, attempts = 0;
  const pending = runVerifierWithReport({ signal: controller.signal, timeoutMs: 30, run: async ({ signal, attempt }) => {
    attempts++;
    if (!attempt) { signalSeen = signal; return { events: events('invalid report') }; }
    assert.equal(signal, signalSeen);
    return new Promise(() => {});
  } });
  await assert.rejects(pending, { code: 'verifier_timeout' });
  assert.equal(attempts, 2);
  assert.equal(signalSeen.aborted, true);
});

test('finished and failed reviews clear their timer and parent listener', async () => {
  const controller = new AbortController();
  let childSignal;
  assert.equal(await runBoundedVerification({ signal: controller.signal, timeoutMs: 10,
    run: signal => { childSignal = signal; return 'finished'; } }), 'finished');
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(childSignal.aborted, false);
  await assert.rejects(runBoundedVerification({ run: () => { throw new Error('offline'); } }), /offline/);
});

test('denied image evidence fails with a specific reason and never receives format recovery', async () => {
  let attempts = 0;
  await assert.rejects(runVerifierWithReport({ run: () => {
    attempts++;
    return { events: [{ channel: 'chat:stream:tool-result', payload: {
      result: JSON.stringify({ status: 'denied', error: 'image_outside_read_scope' }) } }, ...events(JSON.stringify(report))] };
  } }), { code: 'verifier_permission_denied' });
  assert.equal(attempts, 1);
});

test('the factual permission denial retains its classification beside a generic stream failure', async () => {
  await assert.rejects(runVerifierWithReport({ run: () => ({ outcome: { ok: false, error: 'stream failed' }, events: [
    { channel: 'chat:stream:tool-result', payload: { result: { status: 'denied' } } },
    { channel: 'chat:stream:error', payload: { error: 'stream failed' } },
  ] }) }), { code: 'verifier_permission_denied' });
});

test('a live denied result aborts review without waiting for the model to return or try again', async () => {
  let attempts = 0, childSignal;
  await assert.rejects(runVerifierWithReport({ run: ({ signal, onToolResult }) => {
    attempts++; childSignal = signal;
    onToolResult({ status: 'denied', reason: 'image_outside_read_scope' });
    return new Promise(() => {});
  } }), { code: 'verifier_permission_denied' });
  assert.equal(attempts, 1);
  assert.equal(childSignal.aborted, true);
});

test('review limits recognize frozen delegated profiles and retain lower budgets and the existing guard', () => {
  for (const role of ['verifier', 'visual_verifier']) {
    assert.equal(isVerificationTurn({ role }), true);
    assert.equal(isVerificationTurn({ role: 'work_session', agentKind: role }), true);
  }
  assert.equal(isVerificationTurn({ role: 'work_session', agentKind: 'worker' }), false);
  assert.equal(isVerificationTurn({ role: 'project_agent' }), false);
  const guard = {};
  assert.deepEqual(verificationExecutionBudget({ guard }), { guard, maxTurns: 12, maxToolCalls: 128, maxToolBatchCalls: 16 });
  assert.deepEqual(verificationExecutionBudget({ guard, maxTurns: 1, maxToolCalls: 0, maxToolBatchCalls: 2 }),
    { guard, maxTurns: 1, maxToolCalls: 0, maxToolBatchCalls: 2 });
});
