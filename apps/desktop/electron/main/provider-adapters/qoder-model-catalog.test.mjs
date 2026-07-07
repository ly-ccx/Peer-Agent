import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  getQoderModelMetadata,
  listQoderModels,
} from './qoder-model-catalog.mjs';

async function withQoderConfig(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-models-'));
  const configDir = path.join(dir, '.qoder');
  mkdirSync(path.join(configDir, '.auth'), { recursive: true });
  try {
    writeFileSync(path.join(configDir, '.auth/models'), JSON.stringify({
      chat: [
        { key: 'auto', display_name: 'Auto', max_input_tokens: 180000, max_output_tokens: 32768, is_vl: true, is_reasoning: false },
        {
          key: 'ultimate',
          display_name: 'Ultimate',
          max_input_tokens: 1000000,
          max_output_tokens: 32768,
          is_vl: true,
          is_reasoning: true,
          context_config: {
            '1M': { token_count: 1000000 },
            '260K': { token_count: 260000, is_default: true },
          },
        },
      ],
      quest: [
        { key: 'quest-auto', display_name: 'Quest Auto', max_input_tokens: 1, max_output_tokens: 1 },
      ],
    }));
    return await fn({ env: {}, homeDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('qoder model catalog', () => {
  it('lists chat models from the local Qoder catalog', async () => withQoderConfig(async (options) => {
    const result = await listQoderModels(options);

    assert.equal(result.source, 'local');
    assert.deepEqual(result.models.map((model) => model.id), ['auto', 'ultimate']);
    assert.equal(result.models[0].contextWindow, 180000);
    assert.equal(result.models[0].maxOutputTokens, 32768);
    assert.equal(result.models[0].supportsVision, true);
    assert.equal(result.models[1].contextWindow, 1000000);
    assert.equal(result.models[1].supportsReasoning, true);
  }));

  it('looks up metadata case-insensitively', async () => withQoderConfig((options) => {
    const model = getQoderModelMetadata('ULTIMATE', options);

    assert.equal(model.id, 'ultimate');
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.supportsReasoning, true);
  }));

  it('uses the maximum input window for Peer Agent context budget', async () => withQoderConfig(async (options) => {
    const result = await listQoderModels(options);
    const model = result.models.find((item) => item.id === 'ultimate');

    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.raw.max_input_tokens, 1000000);
  }));

  it('falls back to auto when no local catalog exists', async () => {
    const result = await listQoderModels({ env: {}, homeDir: '/missing-qoder-home' });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.models.map((model) => model.id), ['auto']);
  });
});
