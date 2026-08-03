import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { llmBrandLabel, resolveLlmBrand } from './llmBrand.ts';

const assetDirectory = fileURLToPath(new URL('../../assets/llm-providers/', import.meta.url));
const iconComponentSource = readFileSync(fileURLToPath(new URL('./LlmBrandIcon.tsx', import.meta.url)), 'utf8');
const sources = readFileSync(`${assetDirectory}/SOURCES.md`, 'utf8');
const officialAssets = [
  'openai.png',
  'anthropic.png',
  'gemini.jpg',
  'xai.png',
  'qoder.svg',
  'deepseek.png',
  'qwen.png',
  'meta.png',
  'mistral.png',
] as const;

describe('LLM brand icon resolution', () => {
  it('resolves built-in provider templates from stable provider hints', () => {
    assert.equal(resolveLlmBrand({ brand: 'OpenAI', channelId: 'openai' }), 'openai');
    assert.equal(resolveLlmBrand({ brand: 'Anthropic', serviceTemplateId: 'anthropic-api' }), 'anthropic');
    assert.equal(resolveLlmBrand({ brand: 'Google', channelId: 'gemini' }), 'google');
    assert.equal(resolveLlmBrand({ brand: 'xAI', serviceTemplateId: 'grok-api' }), 'xai');
    assert.equal(resolveLlmBrand({ providerName: 'Qoder CLI' }), 'qoder');
  });

  it('uses model family before a generic provider brand', () => {
    assert.equal(resolveLlmBrand({ providerName: 'OpenRouter', modelId: 'anthropic/claude-sonnet-4' }), 'anthropic');
    assert.equal(resolveLlmBrand({ providerName: 'OpenAI Compatible', modelId: 'deepseek-chat' }), 'deepseek');
    assert.equal(resolveLlmBrand({ providerName: 'Custom', modelId: 'qwen3-coder' }), 'qwen');
    assert.equal(resolveLlmBrand({ providerName: 'Custom', modelId: 'meta-llama/llama-4' }), 'meta');
    assert.equal(resolveLlmBrand({ providerName: 'Custom', modelId: 'mistral-large' }), 'mistral');
  });

  it('does not misrepresent compatible or unknown providers', () => {
    assert.equal(resolveLlmBrand({ brand: 'OpenAI Compatible' }), 'unknown');
    assert.equal(resolveLlmBrand({ brand: 'Anthropic Compatible' }), 'unknown');
    assert.equal(resolveLlmBrand({ providerName: 'Local Gateway', modelId: 'company-model-v2' }), 'unknown');
    assert.equal(llmBrandLabel('unknown'), 'Custom provider');
  });

  it('ships every official asset and records its source', () => {
    for (const fileName of officialAssets) {
      assert.equal(existsSync(`${assetDirectory}/${fileName}`), true, `${fileName} should exist`);
      assert.match(sources, new RegExp(`\\b${fileName.replace('.', '\\.') }\\b`));
      assert.match(iconComponentSource, new RegExp(`llm-providers/${fileName.replace('.', '\\.') }`));
    }
  });

  it('keeps the neutral fallback separate from official brand assets', () => {
    assert.doesNotMatch(iconComponentSource, /const PATHS|PATHS\[brand\]/);
    assert.match(iconComponentSource, /llmBrandAsset\(brand: LlmBrandId\)/);
    assert.match(iconComponentSource, /return OFFICIAL_ASSETS\[brand\] \?\? null/);
  });
});
