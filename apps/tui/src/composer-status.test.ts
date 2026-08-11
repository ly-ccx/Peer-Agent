import { describe, expect, test } from 'bun:test';

import {
  cacheHitPercent,
  combineComposerUsage,
  compactWorkspacePath,
  contextStatus,
  contextTokensFromUsage,
  contextWindowForModel,
  createComposerStatus,
  resolveComposerCacheUsage,
  modelIdFromLabel,
  workspaceBasename,
} from './composer-status.ts';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';

function accounting(
  inputTokens: number,
  contextWindow: number | null,
  pendingUncountedChanges = false,
  counterStatus: ContextAccountingSnapshot['counterStatus'] = 'active',
): ContextAccountingSnapshot {
  return {
    version: 1,
    conversationId: 'conversation-1',
    contentRevision: 1,
    modelKey: 'provider::model',
    revision: 1,
    phase: pendingUncountedChanges ? 'stream_preview' : 'turn_complete',
    compactionEpoch: 0,
    contextWindow,
    inputBudget: contextWindow,
    compactionThresholdTokens:
      contextWindow == null ? null : Math.floor(contextWindow * 0.8),
    authoritativeInputTokens: inputTokens,
    percent:
      contextWindow == null ? null : Math.min(100, Math.round((inputTokens / contextWindow) * 100)),
    pressureSource: 'provider_usage',
    pendingUncountedChanges,
    pendingContentChars: pendingUncountedChanges ? 12 : 0,
    countCapability: { kind: 'observed_usage_only' },
    counterStatus,
    updatedAt: 1,
  };
}

describe('composer status', () => {
  test('formats a real workspace without exposing the home directory owner', () => {
    expect(compactWorkspacePath('/Users/alice/Projects/peer_agent/')).toBe('~/Projects/peer_agent');
    expect(compactWorkspacePath('/home/alice/work/peer_agent')).toBe('~/work/peer_agent');
    expect(workspaceBasename('/Users/alice/Projects/peer_agent/')).toBe('peer_agent');
  });

  test('extracts the model id from the display label', () => {
    expect(modelIdFromLabel('gpt-5.6-sol · ChatGPT')).toBe('gpt-5.6-sol');
    expect(modelIdFromLabel('')).toBe('model not configured');
  });

  test('calculates cache hit rate from cumulative usage and hides zero/unknown', () => {
    expect(cacheHitPercent({ inputTokens: 1_200, cacheReadTokens: 300 })).toBe(20);
    expect(cacheHitPercent({ inputTokens: 0, cacheReadTokens: 1_000 })).toBe(100);
    // Desktop hides cache when cacheRead is 0; CLI must not hard-render 0%.
    expect(cacheHitPercent({ inputTokens: 1_000, cacheReadTokens: 0 })).toBeUndefined();
    expect(cacheHitPercent({ inputTokens: 1_000 })).toBeUndefined();
    expect(cacheHitPercent({ inputTokens: 0, cacheReadTokens: 0 })).toBeUndefined();
  });

  test('combines lifetime and in-flight usage like Desktop tokenUsage + activeUsage', () => {
    expect(combineComposerUsage(
      { inputTokens: 1_000, cacheReadTokens: 4_000 },
      { inputTokens: 200, cacheReadTokens: 800 },
    )).toEqual({ inputTokens: 1_200, cacheReadTokens: 4_800 });
    expect(cacheHitPercent(combineComposerUsage(
      { inputTokens: 1_000, cacheReadTokens: 4_000 },
      { inputTokens: 200, cacheReadTokens: 800 },
    ))).toBe(80);
    // Prefer lifetime+active over a last-request miss.
    expect(resolveComposerCacheUsage({
      lifetimeUsage: { inputTokens: 1_000, cacheReadTokens: 4_000 },
      usage: { inputTokens: 200, cacheReadTokens: 800 },
      lastRequestUsage: { inputTokens: 500, cacheReadTokens: 0 },
    })).toEqual({ inputTokens: 1_200, cacheReadTokens: 4_800 });
  });

  test('uses the repository model-catalog window for supported GPT models', () => {
    expect(contextWindowForModel('gpt-5.6-sol · ChatGPT')).toBe(272_000);
    expect(contextWindowForModel('gpt-5.5')).toBe(272_000);
    expect(contextWindowForModel('custom-model')).toBeUndefined();
  });

  test('uses input plus cache-read tokens as the context numerator', () => {
    expect(contextTokensFromUsage({ inputTokens: 10_000, cacheReadTokens: 5_000 })).toBe(15_000);
    expect(contextTokensFromUsage({ inputTokens: -1, cacheReadTokens: Number.NaN })).toBe(0);
  });

  test('shows a truthful percentage only when the context window is known', () => {
    expect(contextStatus(accounting(35_300, 353_000), 353_000)).toEqual({
      context: 'context 10%',
      contextShort: 'ctx 10%',
      contextPercent: 10,
    });
    expect(contextStatus(accounting(1, 353_000), 353_000).context).toBe('context <1%');
    expect(contextStatus(accounting(12_345, null), undefined)).toEqual({
      context: 'context 12k / ?',
      contextShort: 'ctx 12k / ?',
    });
  });

  test('marks provider count drift without exposing pending state in the percentage', () => {
    expect(contextStatus(accounting(35_300, 353_000, false, 'degraded'), 353_000)).toEqual({
      context: 'context 10%!',
      contextShort: 'ctx 10%!',
      contextPercent: 10,
    });
    expect(contextStatus(accounting(35_300, 353_000, true, 'degraded'), 353_000).context)
      .toBe('context 10%!');
  });

  test('keeps pending accounting internal instead of adding a symbol to context usage', () => {
    expect(contextStatus(accounting(35_300, 353_000, true), 353_000)).toEqual({
      context: 'context 10%',
      contextShort: 'ctx 10%',
      contextPercent: 10,
    });
  });

  test('uses only the provider-backed accounting snapshot', () => {
    expect(contextStatus(
      accounting(17_650, 353_000),
      353_000,
    )).toEqual({
      context: 'context 5%',
      contextShort: 'ctx 5%',
      contextPercent: 5,
    });

    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'chat',
      modelLabel: 'gpt-5.6-sol',
      contextWindow: 353_000,
      usage: { inputTokens: 280_000 },
      contextAccounting: accounting(17_650, 353_000),
    })).toMatchObject({
      context: 'context 5%',
      contextShort: 'ctx 5%',
      contextPercent: 5,
    });
  });

  test('shows zero for a brand-new empty session without treating restored unknown as zero', () => {
    expect(contextStatus(undefined, 500_000, true)).toEqual({
      context: 'context 0%',
      contextShort: 'ctx 0%',
      contextPercent: 0,
    });
    expect(contextStatus(undefined, 500_000, false)).toEqual({
      context: 'context ?',
      contextShort: 'ctx ?',
    });
  });

  test('derives mode permission and actual default reasoning status', () => {
    expect(createComposerStatus({
      workspaceRoot: '/Users/alice/Projects/peer_agent',
      mode: 'chat',
      modelLabel: 'gpt-5.6-sol · ChatGPT',
      // Desktop-aligned: lifetime + in-flight active usage.
      lifetimeUsage: { inputTokens: 1_000, cacheReadTokens: 4_000 },
      usage: { inputTokens: 200, cacheReadTokens: 800 },
      // last-request-only miss must not override cumulative hit.
      lastRequestUsage: { inputTokens: 500, cacheReadTokens: 0 },
    })).toMatchObject({
      workspace: '~/Projects/peer_agent',
      workspaceShort: 'peer_agent',
      // Wire mode is `chat`; status surface shows the Agent product label.
      mode: 'agent',
      permission: 'ask',
      permissionShort: 'ask',
      language: '中文',
      languageShort: 'zh',
      model: 'gpt-5.6-sol',
      effort: 'auto',
      reasoning: 'reasoning auto',
      cache: 'cache 80%',
      cachePercent: 80,
      context: 'context ?',
    });

    // Zero cumulative cacheRead hides the badge (no hard cache 0%).
    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'chat',
      modelLabel: 'grok-4.5',
      usage: { inputTokens: 2_000, cacheReadTokens: 0 },
      lastRequestUsage: { inputTokens: 2_000, cacheReadTokens: 0 },
    }).cache).toBeUndefined();

    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'chat',
      locale: 'en-US',
      modelLabel: 'gpt-5.6-sol',
    })).toMatchObject({
      language: 'English',
      languageShort: 'en',
    });

    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'explorer',
      modelLabel: 'custom-model',
      reasoningEffort: 'high',
    })).toMatchObject({
      mode: 'explorer',
      permission: 'read only',
      permissionShort: 'read',
      effort: 'high',
      reasoning: 'reasoning high',
      context: 'context ?',
    });

    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'chat',
      accessLevel: 'session_local',
      modelLabel: 'custom-model',
    })).toMatchObject({
      permission: 'approve for me',
      permissionShort: 'approve',
    });

    // A known model window alone is not token authority.
    expect(createComposerStatus({
      workspaceRoot: '/tmp/project',
      mode: 'chat',
      modelLabel: 'grok-4.5',
      contextWindow: 500_000,
      usage: { inputTokens: 0 },
    })).toMatchObject({
      context: 'context ?',
      contextShort: 'ctx ?',
    });
  });
});
