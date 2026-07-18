import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GEMINI_DEFAULT_FLASH_MODEL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_PREVIEW_PRO_MODEL,
  GEMINI_3_5_FLASH_MODEL,
  listGeminiModels,
  preferGeminiModel,
} from './gemini-model-catalog.mjs';

describe('Gemini model catalog (gemini-cli curated)', () => {
  it('returns curated gemini-cli models instead of remote /models scraping', async () => {
    const result = await listGeminiModels({ access: 'unused' });
    assert.equal(result.source, 'builtin');
    const ids = result.models.map((m) => m.id);
    assert.ok(ids.includes(GEMINI_DEFAULT_MODEL));
    assert.ok(ids.includes(GEMINI_DEFAULT_FLASH_MODEL));
    assert.ok(ids.includes(GEMINI_3_5_FLASH_MODEL));
    assert.ok(ids.includes(GEMINI_PREVIEW_PRO_MODEL));
    assert.ok(ids.includes('gemini-3.1-pro-preview'));
    assert.ok(ids.includes('gemini-3.1-flash-lite'));
  });

  it('can hide preview models when requested', async () => {
    const result = await listGeminiModels({ access: 'unused' }, { includePreview: false });
    assert.equal(result.models.some((m) => m.id.includes('preview')), false);
    assert.ok(result.models.some((m) => m.id === GEMINI_DEFAULT_MODEL));
  });

  it('prefers gemini-cli DEFAULT_GEMINI_MODEL, not newest version guess', () => {
    const preferred = preferGeminiModel([
      { id: 'gemini-3.5-flash', label: '3.5 flash' },
      { id: 'gemini-3-pro-preview', label: 'preview' },
      { id: 'gemini-2.5-pro', label: '2.5 pro' },
      { id: 'gemini-2.5-flash', label: '2.5 flash' },
    ]);
    assert.equal(preferred?.id, GEMINI_DEFAULT_MODEL);
  });

  it('falls back to stable flash when default pro is missing', () => {
    const preferred = preferGeminiModel([
      { id: 'gemini-3-pro-preview', label: 'preview' },
      { id: GEMINI_DEFAULT_FLASH_MODEL, label: 'flash' },
    ]);
    assert.equal(preferred?.id, GEMINI_DEFAULT_FLASH_MODEL);
  });
});
