import { describe, expect, test } from 'bun:test';

import {
  formatExecModelRef,
  parseExecModelToken,
  resolveExecCatalogEntry,
} from './cli-model-ref.ts';

const catalog = [
  { providerId: 'openai-1', modelId: 'gpt-4o', available: true },
  { providerId: 'openrouter-1', modelId: 'gpt-4o', available: true },
  { providerId: 'openrouter-1', modelId: 'openai/gpt-4o', available: true },
  { providerId: 'anthropic-1', modelId: 'claude-sonnet', available: false, entryId: 'entry-claude' },
];

describe('parseExecModelToken', () => {
  test('keeps a bare model id, including OpenRouter slashes', () => {
    expect(parseExecModelToken('gpt-4o')).toEqual({ model: 'gpt-4o' });
    expect(parseExecModelToken('openai/gpt-4o')).toEqual({ model: 'openai/gpt-4o' });
  });

  test('splits the protocol provider::model composite', () => {
    expect(parseExecModelToken('openai-1::gpt-4o')).toEqual({
      provider: 'openai-1',
      model: 'gpt-4o',
    });
  });

  test('keeps slashes inside the model side of a composite', () => {
    expect(parseExecModelToken('openrouter-1::openai/gpt-4o')).toEqual({
      provider: 'openrouter-1',
      model: 'openai/gpt-4o',
    });
  });
});

describe('resolveExecCatalogEntry', () => {
  test('accepts a unique bare model id', () => {
    const resolved = resolveExecCatalogEntry(catalog, { model: 'openai/gpt-4o' });
    expect(resolved).toEqual({
      ok: true,
      entry: catalog[2],
    });
  });

  test('rejects a colliding bare model id and lists qualified refs', () => {
    const resolved = resolveExecCatalogEntry(catalog, { model: 'gpt-4o' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('openai-1::gpt-4o');
    expect(resolved.message).toContain('openrouter-1::gpt-4o');
    expect(resolved.message).not.toContain('/');
  });

  test('disambiguates with --provider', () => {
    const resolved = resolveExecCatalogEntry(catalog, {
      provider: 'openrouter-1',
      model: 'gpt-4o',
    });
    expect(resolved).toEqual({ ok: true, entry: catalog[1] });
  });

  test('disambiguates with --model provider::model', () => {
    const resolved = resolveExecCatalogEntry(catalog, { model: 'openai-1::gpt-4o' });
    expect(resolved).toEqual({ ok: true, entry: catalog[0] });
  });

  test('rejects a provider/model field conflict', () => {
    const resolved = resolveExecCatalogEntry(catalog, {
      provider: 'openai-1',
      model: 'openrouter-1::gpt-4o',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('conflicts');
  });

  test('matches --provider by entryId', () => {
    const resolved = resolveExecCatalogEntry(catalog, { provider: 'entry-claude' });
    expect(resolved).toEqual({ ok: true, entry: catalog[3] });
  });

  test('resolves a composite that contains a slash in the model id', () => {
    const resolved = resolveExecCatalogEntry(catalog, {
      model: 'openrouter-1::openai/gpt-4o',
    });
    expect(resolved).toEqual({ ok: true, entry: catalog[2] });
  });

  test('rejects a provider-only ref when that provider has multiple models', () => {
    const resolved = resolveExecCatalogEntry(catalog, { provider: 'openrouter-1' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('--provider openrouter-1 is ambiguous');
    expect(resolved.message).toContain('openrouter-1::gpt-4o');
    expect(resolved.message).toContain('openrouter-1::openai/gpt-4o');
  });
});

describe('formatExecModelRef', () => {
  test('uses the protocol separator', () => {
    expect(formatExecModelRef('openai-1', 'gpt-4o')).toBe('openai-1::gpt-4o');
  });
});
