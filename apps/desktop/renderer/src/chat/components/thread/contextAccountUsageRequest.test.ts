import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LlmProviderConfigView, LlmSubscriptionQuota } from '@peer-agent/protocol';
import { createContextAccountUsageRequest, type ContextAccountUsageState } from './contextAccountUsageRequest.ts';

const provider = { id: 'account', accountUsageRevision: 'r1' } as LlmProviderConfigView;
const snapshot = { success: true, accountUsageRevision: 'r1', fetchedAt: '2026-09-05T00:00:00Z' } as LlmSubscriptionQuota;
const dimensions: Record<string, Partial<LlmSubscriptionQuota>> = {
  balance: { balances: [{ currency: 'CNY', total: '12.34', source: 'api_key', scope: 'account' }] },
  windows: { windows: [{ id: 'week', label: 'Weekly', usedPercent: 40 }] },
  unavailable: { unavailable: [{ dimension: 'balance', reason: 'Requires admin credentials' }] },
  local: { localUsage: { source: 'local', scope: 'local_only', requests: 2, inputTokens: 10, outputTokens: 5, note: 'Not an account ledger' } },
};
for (const [dimension, fields] of Object.entries(dimensions)) {
  for (const status of ['success', 'failure', 'wrong-revision']) {
    test(`context-account/${dimension}/refresh-${status}`, async () => {
      const states: ContextAccountUsageState[] = [];
      const value = { ...snapshot, ...fields };
      const controller = createContextAccountUsageRequest(provider, async ({ force }) => {
        if (!force) return value;
        if (status === 'failure') throw new Error('private');
        return { ...value, accountUsageRevision: status === 'wrong-revision' ? 'old' : 'r1' };
      }, state => states.push(state));
      await controller.load();
      assert.deepEqual(states.at(-1)?.quota, value);
      await controller.load(true);
      assert.deepEqual(states.at(-2), { quota: value, loading: true });
      const final = states.at(-1)!;
      assert.equal(final.loading, false);
      if (status === 'wrong-revision') assert.equal(final.quota, undefined);
      else for (const key of Object.keys(fields)) assert.deepEqual(final.quota?.[key as keyof LlmSubscriptionQuota], fields[key as keyof LlmSubscriptionQuota]);
      controller.dispose();
    });
  }
}
test('context-account/open-wiring/forces-refresh-and-disposes', () => {
  const source = readFileSync(new URL('./ContextAccountUsage.tsx', import.meta.url), 'utf8');
  assert.match(source, /void controller\.load\(true\)/);
  assert.doesNotMatch(source, /controller\.load\(false\)/);
  assert.match(source, /return \(\) => \{ controller\.dispose\(\)/);
});

for (const ending of ['success', 'failure']) {
  test(`context-account/open-close-reopen/force-true/late-${ending}`, async () => {
    const old = deferred();
    const states: ContextAccountUsageState[] = [];
    const calls: { id: string; force: boolean }[] = [];
    const fetchQuota = async (input: { id: string; force: boolean }) => {
      calls.push(input);
      return calls.length === 1 ? old.promise : snapshot;
    };
    const first = createContextAccountUsageRequest(provider, fetchQuota, state => states.push(state));
    const pending = first.load(true);
    first.dispose();
    const reopened = createContextAccountUsageRequest(provider, fetchQuota, state => states.push(state));
    await reopened.load(true);
    assert.deepEqual(calls, [{ id: provider.id, force: true }, { id: provider.id, force: true }]);
    assert.deepEqual(states.at(-1), { quota: snapshot, loading: false });
    const before = states.length;
    if (ending === 'success') old.resolve({ ...snapshot, fetchedAt: 'old' });
    else old.reject(new Error('late failure'));
    await pending;
    assert.equal(states.length, before);
    reopened.dispose();
  });
}

test('context-account/open/forced-refresh-failure/ends-loading', async () => {
  const states: ContextAccountUsageState[] = [];
  const controller = createContextAccountUsageRequest(provider, async input => {
    assert.equal(input.force, true);
    throw new Error('private');
  }, state => states.push(state));
  await controller.load(true);
  assert.equal(states.at(-1)?.loading, false);
  assert.equal(states.at(-1)?.quota?.status, 'fetch_failed');
  assert.equal(states.at(-1)?.quota?.error, undefined);
  controller.dispose();
});

function deferred() {
  let resolve!: (value: LlmSubscriptionQuota) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LlmSubscriptionQuota>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
for (const outcome of ['success', 'failure', 'wrong-revision', 'account-changed']) {
  test(`context-account/initial/${outcome}`, async () => {
    const states: ContextAccountUsageState[] = [];
    const request = createContextAccountUsageRequest(provider, async (input) => {
      assert.deepEqual(input, { id: 'account', force: false });
      if (outcome === 'failure') throw new Error('secret must not escape');
      return { ...snapshot, ...(outcome === 'wrong-revision' ? { accountUsageRevision: 'old' } : {}),
        ...(outcome === 'account-changed' ? { status: 'account_changed' as const } : {}) };
    }, (state) => states.push(state));
    await request.load();
    assert.deepEqual(states[0], { loading: true, quota: undefined });
    assert.equal(states.at(-1)?.loading, false);
    if (outcome === 'success') assert.deepEqual(states.at(-1)?.quota, snapshot);
    else if (outcome === 'failure') {
      assert.equal(states.at(-1)?.quota?.status, 'fetch_failed');
      assert.equal(states.at(-1)?.quota?.error, undefined);
    } else assert.equal(states.at(-1)?.quota, undefined);
  });
}
for (const ending of ['success', 'failure']) {
  for (const invalidation of ['newer-request', 'dispose']) {
    test(`context-account/${invalidation}/late-${ending}`, async () => {
      const old = deferred();
      const states: ContextAccountUsageState[] = [];
      let calls = 0;
      const request = createContextAccountUsageRequest(provider, async () => ++calls === 1 ? old.promise : snapshot,
        (state) => states.push(state));
      const first = request.load();
      if (invalidation === 'dispose') request.dispose();
      else await request.load(true);
      const before = states.length;
      if (ending === 'success') old.resolve({ ...snapshot, fetchedAt: 'old' });
      else old.reject(new Error('late'));
      await first;
      assert.equal(states.length, before);
      if (invalidation === 'newer-request') assert.deepEqual(states.at(-1)?.quota, snapshot);
    });
  }
}
test('context-account/refresh-failure/preserves-observation-not-timestamp', async () => {
  const states: ContextAccountUsageState[] = [];
  const request = createContextAccountUsageRequest(provider, async ({ force }) => {
    if (force) throw new Error('unavailable');
    return snapshot;
  }, (state) => states.push(state));
  await request.load();
  await request.load(true);
  assert.equal(states.at(-1)?.quota?.stale, true);
  assert.equal(states.at(-1)?.quota?.fetchedAt, snapshot.fetchedAt);
  assert.equal(states.at(-1)?.loading, false);
});
