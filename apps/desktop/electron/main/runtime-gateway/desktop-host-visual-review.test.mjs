import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopHostVisualReview } from './desktop-host-visual-review.mjs';

function observation(hash) {
  return { artifactHash: hash, artifactRef: `local-desktop-preview-artifact://${hash}` };
}

test('observe/host-review/schedules-independent-verifier', async () => {
  const calls = [];
  const host = createDesktopHostVisualReview({
    runVerifier: async (input) => { calls.push(input); return { passed: true }; },
  });
  const plan = { planId: 'plan' };
  const result = host.schedule(plan, observation('a'.repeat(64)), { workspacePath: '/tmp' });
  assert.equal(result.scheduled, true);
  assert.match(result.verifierRunId, /^visual-verifier:/);
  await result.promise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.planId, 'plan');
  assert.equal(host.reviewedHashFor('plan'), 'a'.repeat(64));
});

test('observe/same-hash-dedup/does-not-reschedule', async () => {
  let finish;
  const host = createDesktopHostVisualReview({
    runVerifier: () => new Promise((resolve) => { finish = resolve; }),
  });
  const plan = { planId: 'plan' };
  const first = host.schedule(plan, observation('b'.repeat(64)));
  const second = host.schedule(plan, observation('b'.repeat(64)));
  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.reason, 'preview-review-in-flight');
  finish({ passed: true });
  await first.promise;
  const third = host.schedule(plan, observation('b'.repeat(64)));
  assert.equal(third.scheduled, false);
  assert.equal(third.reason, 'preview-review-already-admitted');
});

test('observe/newer-hash-supersedes/aborts-inflight', async () => {
  const started = [];
  const host = createDesktopHostVisualReview({
    runVerifier: ({ signal, verifierRunId }) => new Promise((resolve, reject) => {
      started.push(verifierRunId);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const plan = { planId: 'plan' };
  const first = host.schedule(plan, observation('c'.repeat(64)));
  const second = host.schedule(plan, observation('d'.repeat(64)));
  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, true);
  assert.equal(started.length, 2);
  await assert.rejects(first.promise, /aborted/);
  assert.equal(host.inflightFor('plan')?.artifactHash, 'd'.repeat(64));
  host.dispose();
});

test('observe/missing-identity/does-not-schedule', () => {
  const host = createDesktopHostVisualReview({ runVerifier: async () => ({ passed: true }) });
  assert.equal(host.schedule(null, observation('e'.repeat(64))).scheduled, false);
  assert.equal(host.schedule({ planId: 'plan' }, {}).scheduled, false);
});

test('host-review/failure/is-reported-and-never-swallowed', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({ runVerifier: async () => { throw new Error('boom'); } });
  const result = host.schedule({ planId: 'plan' }, observation('f'.repeat(64)), {
    onFailure: (planId, reason) => reported.push({ planId, reason }),
  });
  await assert.rejects(result.promise, /boom/);
  assert.deepEqual(reported, [{ planId: 'plan', reason: 'visual-review-host-error' }]);
  assert.equal(host.lastFailureFor('plan').reason, 'visual-review-host-error');
});

test('host-review/visual-review-error/keeps-its-own-reason', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({
    runVerifier: async () => { throw new Error('visual-review-service-unavailable'); },
  });
  const result = host.schedule({ planId: 'plan' }, observation('9'.repeat(64)), {
    onFailure: (planId, reason) => reported.push(reason),
  });
  await assert.rejects(result.promise, /service-unavailable/);
  assert.deepEqual(reported, ['visual-review-service-unavailable']);
  assert.equal(host.lastFailureFor('plan').reason, 'visual-review-service-unavailable');
});

test('host-review/superseded-review/is-not-a-failure', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({
    runVerifier: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const plan = { planId: 'plan' };
  const first = host.schedule(plan, observation('1'.repeat(64)), { onFailure: reason => reported.push(reason) });
  host.schedule(plan, observation('2'.repeat(64)), { onFailure: reason => reported.push(reason) });
  await assert.rejects(first.promise, /aborted/);
  assert.deepEqual(reported, []);
  assert.equal(host.lastFailureFor('plan'), null);
  host.dispose();
});

test('host-review/never-settles/reports-a-bounded-timeout-instead-of-hanging', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({ runVerifier: () => new Promise(() => {}) });
  const result = host.schedule({ planId: 'plan' }, observation('3'.repeat(64)), {
    timeoutMs: 20, onFailure: (planId, reason) => reported.push({ planId, reason }),
  });
  await assert.rejects(result.promise, /visual-review-timeout/);
  assert.deepEqual(reported, [{ planId: 'plan', reason: 'visual-review-timeout' }]);
  assert.equal(host.lastFailureFor('plan').reason, 'visual-review-timeout');
  // A timed-out review must not look admitted, and must not stay in flight forever.
  assert.equal(host.reviewedHashFor('plan'), null);
  assert.equal(host.inflightFor('plan'), null);
});

test('host-review/slow-but-settling/does-not-time-out', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({
    runVerifier: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { passed: true }; },
  });
  const result = host.schedule({ planId: 'plan' }, observation('4'.repeat(64)), {
    timeoutMs: 300, onFailure: reason => reported.push(reason),
  });
  assert.equal((await result.promise).passed, true);
  assert.deepEqual(reported, []);
  assert.equal(host.lastFailureFor('plan'), null);
  assert.equal(host.reviewedHashFor('plan'), '4'.repeat(64));
});

test('host-review/superseded-work/never-times-out-afterwards', async () => {
  // 两件事必须分开断言：被替换的那次复核是取消（静默），而仍在飞的另一次若始终不落地
  // 就是真实超时（必须上报）。把两者混在一个数组里会掩盖「超时静默」这个 bug。
  const supersededReports = [];
  const survivingReports = [];
  const host = createDesktopHostVisualReview({
    runVerifier: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const plan = { planId: 'plan' };
  const first = host.schedule(plan, observation('5'.repeat(64)), { timeoutMs: 60, onFailure: r => supersededReports.push(r) });
  host.schedule(plan, observation('6'.repeat(64)), { timeoutMs: 20, onFailure: r => survivingReports.push(r) });
  await assert.rejects(first.promise, /aborted/);
  // Outlive the superseded review's watchdog: cancelling it must also retire its timer,
  // otherwise a replaced image would turn into a bogus timeout failure.
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(supersededReports, [], '被替换的复核是取消，不得上报');
  assert.deepEqual(survivingReports, ['plan'], '始终不落地的复核是超时，必须上报');
  host.dispose();
});

test('host-review/dispose/clears-the-watchdog', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({ runVerifier: () => new Promise(() => {}) });
  host.schedule({ planId: 'plan' }, observation('7'.repeat(64)), {
    timeoutMs: 20, onFailure: reason => reported.push(reason),
  });
  host.dispose();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(reported, []);
});

test('host-review/index-late/waits-then-passes', async () => {
  let attempts = 0;
  const reported = [];
  const host = createDesktopHostVisualReview({
    runVerifier: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('preview-artifact-unindexed');
      return { passed: true };
    },
  });
  const result = await host.schedule({ planId: 'plan' }, observation('b'.repeat(64)), {
    onFailure: reason => reported.push(reason),
  }).promise;
  assert.equal(attempts, 3, '必须重试到索引落地');
  assert.equal(result.passed, true);
  assert.deepEqual(reported, [], '排序竞争不是复核失败');
  assert.equal(host.lastFailureFor('plan'), null);
});

test('host-review/index-never-lands/reports-a-precise-reason', async () => {
  const reported = [];
  const host = createDesktopHostVisualReview({
    runVerifier: async () => { throw new Error('preview-artifact-unindexed'); },
  });
  const result = host.schedule({ planId: 'plan' }, observation('c'.repeat(64)), {
    onFailure: (planId, reason) => reported.push(reason),
  });
  await assert.rejects(result.promise, /unindexed/);
  assert.deepEqual(reported, ['visual-review-evidence-unindexed']);
  assert.equal(host.lastFailureFor('plan').reason, 'visual-review-evidence-unindexed');
});

test('host-review/index-late/does-not-retry-other-errors', async () => {
  let attempts = 0;
  const host = createDesktopHostVisualReview({
    runVerifier: async () => { attempts += 1; throw new Error('visual-review-service-unavailable'); },
  });
  await assert.rejects(host.schedule({ planId: 'plan' }, observation('d'.repeat(64))).promise,
    /service-unavailable/);
  assert.equal(attempts, 1, '非索引类错误不得重试');
});
