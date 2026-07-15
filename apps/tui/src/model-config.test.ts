import { describe, expect, test } from 'bun:test';

import {
  createEnvironmentCredentialPort,
  missingModelConfigurationMessage,
  resolveTuiModelConfig,
  TUI_MODEL_ENV,
} from './model-config.ts';

describe('TUI model environment', () => {
  test('resolves a credential through the public credential port', async () => {
    const environment = {
      [TUI_MODEL_ENV.apiKey]: '  test-secret  ',
      [TUI_MODEL_ENV.baseUrl]: ' https://models.example/v1 ',
      [TUI_MODEL_ENV.model]: ' model-test ',
    };
    const config = resolveTuiModelConfig(environment, { loadSharedMetadata: () => null, loadSharedSelection: () => null });

    expect(config.configured).toBe(true);
    expect(config.source).toBe('environment');
    expect(config.modelLabel).toBe('model-test · env');
    expect(config.model).toBe('model-test');
    expect(await config.credentials.resolve({ providerId: 'openai-compatible' })).toEqual({
      apiKey: 'test-secret',
      baseUrl: 'https://models.example/v1',
    });
  });

  test('does not hand credentials to another provider', async () => {
    const credentials = createEnvironmentCredentialPort({
      [TUI_MODEL_ENV.apiKey]: 'test-secret',
    });

    expect(await credentials.resolve({ providerId: 'other' })).toBeNull();
  });

  test('uses the desktop default when no environment override exists', () => {
    const config = resolveTuiModelConfig({}, {
      loadSharedMetadata: () => ({
        source: 'desktop-default',
        providerId: 'openai',
        credentialId: 'desktop-group',
        displayName: 'ChatGPT subscription',
        model: 'gpt-shared',
        baseUrl: 'https://chatgpt.example/codex',
        authMethod: 'oauth_chatgpt',
        credentialStored: true,
        configFile: '/tmp/llm-providers.json',
      }),
      loadSharedSelection: () => ({
        source: 'desktop-default',
        providerId: 'openai',
        credentialId: 'desktop-group',
        displayName: 'ChatGPT subscription',
        model: 'gpt-shared',
        baseUrl: 'https://chatgpt.example/codex',
        authMethod: 'oauth_chatgpt',
        credentialStored: true,
        oauthTokens: { access: 'hidden' },
        configFile: '/tmp/llm-providers.json',
        persistOAuthTokens() {},
      }),
    });

    expect(config.configured).toBe(true);
    expect(config.source).toBe('desktop-default');
    expect(config.providerId).toBe('chatgpt-subscription');
    expect(config.model).toBe('gpt-shared');
    expect(config.modelLabel).toBe('gpt-shared · desktop default');
    expect(config.resolveSharedSelection?.()?.oauthTokens?.access).toBe('hidden');
  });

  test('shows desktop model metadata before a locked credential is decrypted', () => {
    const config = resolveTuiModelConfig({}, {
      loadSharedMetadata: () => ({
        source: 'desktop-default', providerId: 'openai', credentialId: 'desktop-group',
        displayName: 'ChatGPT subscription', model: 'gpt-locked',
        baseUrl: 'https://chatgpt.example/codex', authMethod: 'oauth_chatgpt',
        credentialStored: true, configFile: '/tmp/llm-providers.json',
      }),
      loadSharedSelection: () => { throw new Error('keychain_cancelled'); },
    });
    expect(config.modelLabel).toBe('gpt-locked · desktop default');
    expect(config.configured).toBe(true);
    expect(() => config.resolveSharedSelection?.()).toThrow('keychain_cancelled');
  });

  test('uses a safe missing-config state without including a secret', async () => {
    const config = resolveTuiModelConfig({}, { loadSharedMetadata: () => null, loadSharedSelection: () => null });
    const message = missingModelConfigurationMessage();

    expect(config.configured).toBe(false);
    expect(config.model).toBe('gpt-4o-mini');
    expect(await config.credentials.resolve({ providerId: 'openai-compatible' })).toBeNull();
    expect(message).toContain(TUI_MODEL_ENV.apiKey);
    expect(message).not.toContain('test-secret');
  });
});
