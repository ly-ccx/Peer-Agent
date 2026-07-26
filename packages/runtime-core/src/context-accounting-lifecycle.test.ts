import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextAccountingLifecycle,
  createUnknownContextAccountingSnapshot,
  isContextAccountingSnapshotCurrent,
} from './context-accounting-lifecycle.ts';

const identity = {
  conversationId: 'conversation-1',
  contentRevision: 3,
  modelKey: 'provider::model',
};

test('one lifecycle owns stable, stream, tool, and model invalidation revisions', () => {
  const phases: string[] = [];
  const initial = createUnknownContextAccountingSnapshot({
    identity,
    contextWindow: 100_000,
    countCapability: { kind: 'observed_usage_only' },
    now: 1,
  });
  const lifecycle = createContextAccountingLifecycle({
    initialSnapshot: initial,
    onSnapshot: (snapshot) => phases.push(snapshot.phase),
    now: () => 2,
  });
  const observed = {
    ...initial,
    authoritativeInputTokens: 40_000,
    percent: 40,
    pressureSource: 'provider_usage' as const,
    pendingUncountedChanges: false,
    lastObserved: {
      inputTokens: 40_000,
      requestFingerprint: 'ctx_request',
      compactionEpoch: 0,
      source: 'provider_usage' as const,
      observedAt: 1,
    },
  };

  lifecycle.stable(observed, 'request_preflight');
  const preview = lifecycle.streamPreview('hello');
  const tool = lifecycle.markPending('tool_result', 10);
  const changed = lifecycle.invalidateModel({
    identity: { ...identity, modelKey: 'provider::next-model' },
    contextWindow: 200_000,
    countCapability: { kind: 'unavailable' },
  });

  assert.deepEqual(phases, [
    'request_preflight',
    'stream_preview',
    'tool_result',
    'model_changed',
  ]);
  assert.equal(preview.authoritativeInputTokens, 40_000);
  assert.equal(preview.percent, 40);
  assert.equal(preview.pendingUncountedChanges, true);
  assert.equal(preview.pendingContentChars, 5);
  assert.equal(tool.pendingContentChars, 15);
  assert.equal(changed.authoritativeInputTokens, null);
  assert.equal(changed.percent, null);
  assert.equal(changed.contextWindow, 200_000);
  assert.equal(changed.modelKey, 'provider::next-model');
  assert.ok(changed.revision > tool.revision);
});
test('snapshot identity validation rejects another revision or model', () => {
  const snapshot = createUnknownContextAccountingSnapshot({
    identity,
    contextWindow: null,
    countCapability: { kind: 'unavailable' },
  });

  assert.equal(isContextAccountingSnapshotCurrent(snapshot, identity), true);
  assert.equal(
    isContextAccountingSnapshotCurrent(snapshot, { ...identity, contentRevision: 4 }),
    false,
  );
  assert.equal(
    isContextAccountingSnapshotCurrent(snapshot, { ...identity, modelKey: 'other' }),
    false,
  );
});
