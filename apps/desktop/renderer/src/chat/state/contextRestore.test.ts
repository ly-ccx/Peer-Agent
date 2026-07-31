import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
import {
  contextAccountingRestoreKey,
  shouldRestoreContextAccounting,
  shouldStartContextAccountingRestore,
} from './contextRestore.ts';

function snapshot(
  overrides: Partial<ContextAccountingSnapshot> = {},
): ContextAccountingSnapshot {
  return {
    version: 1,
    conversationId: 'conversation-1',
    contentRevision: 3,
    modelKey: 'provider-1::model-1',
    revision: 2,
    phase: 'restored',
    compactionEpoch: 0,
    contextWindow: 100_000,
    inputBudget: 100_000,
    compactionThresholdTokens: 80_000,
    authoritativeInputTokens: 25_000,
    percent: 25,
    pressureSource: 'provider_usage',
    pendingUncountedChanges: false,
    pendingContentChars: 0,
    countCapability: { kind: 'observed_usage_only' },
    counterStatus: 'active',
    updatedAt: 1,
    ...overrides,
  };
}

describe('shouldRestoreContextAccounting', () => {
  it('restores an unknown historical snapshot even when its canonical model identity matches', () => {
    assert.equal(shouldRestoreContextAccounting({
      snapshot: snapshot({
        authoritativeInputTokens: null,
        percent: null,
        pressureSource: 'unknown',
        phase: 'restored',
      }),
      providerId: 'provider-1',
      model: 'model-1',
    }), true);
  });

  it('keeps a provider-backed snapshot when its canonical model identity matches', () => {
    assert.equal(shouldRestoreContextAccounting({
      snapshot: snapshot(),
      providerId: 'provider-1',
      model: 'model-1',
    }), false);
  });

  it('restores when the model identity changes', () => {
    assert.equal(shouldRestoreContextAccounting({
      snapshot: snapshot(),
      providerId: 'provider-1',
      model: 'model-2',
    }), true);
  });
});

describe('shouldStartContextAccountingRestore', () => {
  const restoreInput = {
    conversationId: 'conversation-1',
    providerId: 'provider-1',
    model: 'model-1',
  } as const;

  it('attempts an unknown snapshot only once for the same content revision', () => {
    const unknown = snapshot({
      authoritativeInputTokens: null,
      percent: null,
      pressureSource: 'unknown',
    });
    const attemptedKeys = new Set([
      contextAccountingRestoreKey({ ...restoreInput, snapshot: unknown }),
    ]);

    assert.equal(shouldStartContextAccountingRestore({
      ...restoreInput,
      snapshot: unknown,
      attemptedKeys,
    }), false);
  });

  it('allows another restore when the content revision changes', () => {
    const previous = snapshot({
      contentRevision: 3,
      authoritativeInputTokens: null,
      percent: null,
      pressureSource: 'unknown',
    });
    const current = snapshot({
      contentRevision: 4,
      authoritativeInputTokens: null,
      percent: null,
      pressureSource: 'unknown',
    });
    const attemptedKeys = new Set([
      contextAccountingRestoreKey({ ...restoreInput, snapshot: previous }),
    ]);

    assert.equal(shouldStartContextAccountingRestore({
      ...restoreInput,
      snapshot: current,
      attemptedKeys,
    }), true);
  });

  it('allows another restore when the model changes', () => {
    const current = snapshot({
      authoritativeInputTokens: null,
      percent: null,
      pressureSource: 'unknown',
    });
    const attemptedKeys = new Set([
      contextAccountingRestoreKey({ ...restoreInput, snapshot: current }),
    ]);

    assert.equal(shouldStartContextAccountingRestore({
      ...restoreInput,
      model: 'model-2',
      snapshot: current,
      attemptedKeys,
    }), true);
  });
});
