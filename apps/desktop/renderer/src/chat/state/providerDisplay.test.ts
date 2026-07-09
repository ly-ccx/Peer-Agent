import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getProviderDisplayName, getProviderModelDisplayLabel } from './providerDisplay.ts';

const baseProvider = {
  authMethod: 'oauth_chatgpt' as const,
  name: 'ChatGPT 订阅',
  model: 'GPT-5.5',
};

describe('providerDisplay', () => {
  it('localizes the built-in ChatGPT subscription name in English', () => {
    assert.equal(getProviderDisplayName(baseProvider, false), 'ChatGPT Subscription');
    assert.equal(getProviderModelDisplayLabel(baseProvider, false), 'ChatGPT Subscription · GPT-5.5');
  });

  it('keeps the built-in ChatGPT subscription name in Chinese', () => {
    assert.equal(getProviderDisplayName(baseProvider, true), 'ChatGPT 订阅');
    assert.equal(getProviderModelDisplayLabel(baseProvider, true), 'ChatGPT 订阅 · GPT-5.5');
  });

  it('also localizes providers saved with the English default name', () => {
    const provider = { ...baseProvider, name: 'ChatGPT Subscription' };
    assert.equal(getProviderDisplayName(provider, true), 'ChatGPT 订阅');
    assert.equal(getProviderDisplayName(provider, false), 'ChatGPT Subscription');
  });

  it('does not translate user customized provider names', () => {
    const provider = { ...baseProvider, name: 'My Plus Account' };
    assert.equal(getProviderDisplayName(provider, true), 'My Plus Account');
    assert.equal(getProviderDisplayName(provider, false), 'My Plus Account');
    assert.equal(getProviderModelDisplayLabel(provider, false), 'My Plus Account · GPT-5.5');
  });

  it('does not translate non-ChatGPT-subscription providers', () => {
    const provider = {
      authMethod: 'api_key' as const,
      name: 'ChatGPT 订阅',
      model: 'gpt-4.1',
    };
    assert.equal(getProviderDisplayName(provider, false), 'ChatGPT 订阅');
  });

  it('keeps explicit model labels unchanged', () => {
    assert.equal(
      getProviderModelDisplayLabel({ ...baseProvider, modelLabel: 'GPT-5.5 Preview' }, false),
      'GPT-5.5 Preview',
    );
  });
});
