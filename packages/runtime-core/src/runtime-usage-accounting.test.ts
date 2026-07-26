import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRuntimeUsageAccounting } from './runtime-usage-accounting.ts';

describe('RuntimeUsageAccounting', () => {
  it('keeps provider-request context separate from runtime-turn billing totals', () => {
    const accounting = createRuntimeUsageAccounting();

    accounting.observeProviderRequest({
      inputTokens: 30,
      outputTokens: 2,
      cacheReadTokens: 5,
    }, { requestFingerprint: 'request-1' });
    accounting.observeProviderRequest({
      inputTokens: 40,
      outputTokens: 3,
      cacheReadTokens: 5,
    }, { requestFingerprint: 'request-2' });
    accounting.observeProviderRequest({
      inputTokens: 50,
      outputTokens: 4,
      cacheReadTokens: 5,
    }, { requestFingerprint: 'request-3' });

    const snapshot = accounting.snapshot();
    assert.deepEqual(snapshot.lastRequest, {
      usageScope: 'provider_request',
      requestIndex: 3,
      requestPurpose: 'agent',
      requestFingerprint: 'request-3',
      inputTokens: 50,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      totalTokens: 59,
    });
    assert.deepEqual(snapshot.turnTotal, {
      usageScope: 'runtime_turn',
      providerRequestCount: 3,
      inputTokens: 120,
      outputTokens: 9,
      cacheReadTokens: 15,
      cacheWriteTokens: 0,
      totalTokens: 144,
    });
  });

  it('counts provider rounds without erasing the last observed usage when a round has none', () => {
    const accounting = createRuntimeUsageAccounting();
    accounting.observeProviderRequest({ inputTokens: 10 });
    accounting.observeProviderRequest(null);

    const snapshot = accounting.snapshot();
    assert.equal(snapshot.providerRequestCount, 2);
    assert.equal(snapshot.lastRequest?.requestIndex, 1);
    assert.equal(snapshot.turnTotal.providerRequestCount, 2);
    assert.equal(snapshot.turnTotal.inputTokens, 10);
  });

  it('bills auxiliary summary requests without replacing context-capacity truth', () => {
    const accounting = createRuntimeUsageAccounting();
    accounting.observeProviderRequest(
      { inputTokens: 50 },
      { requestFingerprint: 'agent-request' },
    );
    accounting.observeProviderRequest(
      { inputTokens: 20, outputTokens: 5 },
      {
        requestPurpose: 'compaction_summary',
        capacityBearing: false,
      },
    );

    const snapshot = accounting.snapshot();
    assert.equal(snapshot.providerRequestCount, 2);
    assert.equal(snapshot.turnTotal.totalTokens, 75);
    assert.equal(snapshot.lastRequest?.requestFingerprint, 'agent-request');
    assert.equal(snapshot.lastRequest?.requestIndex, 1);
  });
});
