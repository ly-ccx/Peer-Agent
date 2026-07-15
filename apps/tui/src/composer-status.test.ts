import { describe, expect, test } from 'bun:test';

import {
  compactWorkspacePath,
  contextStatus,
  contextTokensFromUsage,
  contextWindowForModel,
  createComposerStatus,
  modelIdFromLabel,
  workspaceBasename,
} from './composer-status.ts';

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

  test('uses the repository model-catalog window for supported GPT models', () => {
    expect(contextWindowForModel('gpt-5.6-sol · ChatGPT')).toBe(353_000);
    expect(contextWindowForModel('gpt-5.5')).toBe(258_000);
    expect(contextWindowForModel('custom-model')).toBeUndefined();
  });

  test('uses input plus cache-read tokens as the context numerator', () => {
    expect(contextTokensFromUsage({ inputTokens: 10_000, cacheReadTokens: 5_000 })).toBe(15_000);
    expect(contextTokensFromUsage({ inputTokens: -1, cacheReadTokens: Number.NaN })).toBe(0);
  });

  test('shows a truthful percentage only when the context window is known', () => {
    expect(contextStatus({ inputTokens: 35_300 }, 353_000)).toEqual({
      context: 'context 10%',
      contextShort: 'ctx 10%',
      contextPercent: 10,
    });
    expect(contextStatus({ inputTokens: 1 }, 353_000).context).toBe('context <1%');
    expect(contextStatus({ inputTokens: 12_345 }, undefined)).toEqual({
      context: 'context 12k / ?',
      contextShort: 'ctx 12k / ?',
    });
  });

  test('derives mode permission and actual default reasoning status', () => {
    expect(createComposerStatus({
      workspaceRoot: '/Users/alice/Projects/peer_agent',
      mode: 'chat',
      modelLabel: 'gpt-5.6-sol · ChatGPT',
      usage: { inputTokens: 0 },
    })).toMatchObject({
      workspace: '~/Projects/peer_agent',
      workspaceShort: 'peer_agent',
      mode: 'chat',
      permission: 'ask before write',
      permissionShort: 'ask',
      model: 'gpt-5.6-sol',
      reasoning: 'reasoning auto',
      context: 'context 0%',
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
      reasoning: 'reasoning high',
      context: 'context 0 / ?',
    });
  });
});
