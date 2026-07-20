import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  getQoderModelMetadata,
  listQoderModels,
  resolveQoderModelOptionProjection,
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

  it('normalizes Qoder context tiers into a generic select option', async () => withQoderConfig(async (options) => {
    const result = await listQoderModels(options);
    const model = result.models.find((item) => item.id === 'ultimate');

    assert.equal(model.contextWindow, 1000000);
    assert.deepEqual(model.modelOptions, [{
      id: 'contextTier',
      label: '上下文档位',
      kind: 'select',
      description: '总上下文窗口；最大输入会为模型输出和运行时内容预留空间。',
      defaultValue: '260K',
      choices: [
        {
          value: '1M',
          label: '1M',
          requestValue: '1M',
          contextWindow: 1000000,
          inputTokenLimit: 1000000,
        },
        {
          value: '260K',
          label: '260K',
          requestValue: '260K',
          contextWindow: 260000,
          inputTokenLimit: 260000,
        },
      ],
    }]);
  }));

  it('preserves the default input reserve across larger context tiers', async () => withQoderConfig(async (options) => {
    const modelFile = path.join(options.homeDir, '.qoder', '.auth', 'models');
    writeFileSync(modelFile, JSON.stringify({
      chat: [{
        key: 'kimi-k3',
        max_input_tokens: 180000,
        context_config: {
          '200K': { token_count: 200000, is_default: true },
          '400K': { token_count: 400000 },
          '1M': { token_count: 1000000 },
        },
      }],
    }));

    const result = await listQoderModels(options);
    const option = result.models[0].modelOptions[0];

    assert.equal(option.defaultValue, '200K');
    assert.deepEqual(option.choices.map((choice) => [choice.value, choice.contextWindow, choice.inputTokenLimit]), [
      ['200K', 200000, 180000],
      ['400K', 400000, 380000],
      ['1M', 1000000, 980000],
    ]);

    rmSync(modelFile);
    const cachedMetadata = getQoderModelMetadata('kimi-k3', options);
    assert.equal(cachedMetadata?.contextWindow, 180000);
    assert.equal(cachedMetadata?.modelOptions?.[0]?.defaultValue, '200K');
  }));

  it('projects a selected context tier into request and input budgets', async () => withQoderConfig(async (options) => {
    const modelFile = path.join(options.homeDir, '.qoder', '.auth', 'models');
    writeFileSync(modelFile, JSON.stringify({
      chat: [{
        key: 'kimi-k3',
        max_input_tokens: 180000,
        context_config: {
          '200K': { token_count: 200000, is_default: true },
          '400K': { token_count: 400000 },
          '1M': { token_count: 1000000 },
        },
      }],
    }));

    const metadata = getQoderModelMetadata('kimi-k3', options);
    assert.deepEqual(resolveQoderModelOptionProjection(metadata, { contextTier: '1M' }), {
      contextWindow: 1000000,
      inputTokenLimit: 980000,
      requestOptions: { contextTier: '1M' },
    });
    assert.deepEqual(resolveQoderModelOptionProjection(metadata, { contextTier: 'invalid' }), {
      contextWindow: 200000,
      inputTokenLimit: 180000,
      requestOptions: { contextTier: '200K' },
    });
  }));

  it('falls back to auto when no local catalog exists', async () => {
    const result = await listQoderModels({ env: {}, homeDir: '/missing-qoder-home' });

    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.models.map((model) => model.id), ['auto']);
  });
});

it('preserves non-ENOENT encrypted catalog errors when legacy cache is missing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qoder-models-err-'));
  const configDir = path.join(dir, '.qoder');
  const uid = 'test-uid';
  mkdirSync(path.join(configDir, '.models', uid), { recursive: true });
  writeFileSync(path.join(configDir, '.models', 'default'), JSON.stringify({ uid }), 'utf8');
  // 有加密目录文件，但无 qodercli/wasm 可解密，且无 legacy .auth/models。
  writeFileSync(path.join(configDir, '.models', uid, 'catalog-v5'), 'not-a-valid-cipher', 'utf8');
  const previousPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    const result = await listQoderModels({
      env: { PATH: '/usr/bin:/bin', HOME: dir, QODER_CONFIG_DIR: configDir },
      homeDir: dir,
    });
    assert.equal(result.source, 'fallback');
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].id, 'auto');
    // 文件存在但解密失败时，不应再误报 not_found。
    assert.notEqual(result.error, 'qoder_models_not_found');
    assert.ok(String(result.error || '').startsWith('qoder_'));
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
