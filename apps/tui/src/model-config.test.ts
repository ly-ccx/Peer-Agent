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
    expect(config.providerId).toBe('desktop-group');
    expect(config.model).toBe('gpt-shared');
    expect(config.modelLabel).toBe('gpt-shared · desktop default');
    expect(config.resolveSharedSelection?.()?.oauthTokens?.access).toBe('hidden');
  });

  test('builds a catalog from every supported configured desktop provider', () => {
    const config = resolveTuiModelConfig({}, {
      loadSharedMetadata: () => ({
        source: 'desktop-default', providerId: 'openai', credentialId: 'credential-a',
        displayName: 'Provider A', model: 'model-a', baseUrl: 'https://a.example/v1',
        authMethod: 'api_key', credentialStored: true, configFile: '/tmp/llm-providers.json',
      }),
      loadSharedMetadataList: () => [
        {
          source: 'desktop-default', providerId: 'openai', credentialId: 'credential-a',
          displayName: 'Provider A', model: 'model-a', baseUrl: 'https://a.example/v1',
          authMethod: 'api_key', credentialStored: true, configFile: '/tmp/llm-providers.json',
        },
        {
          source: 'desktop-default', providerId: 'openai', credentialId: 'credential-b',
          displayName: 'Provider B', model: 'model-b', baseUrl: 'https://b.example/v1',
          authMethod: 'oauth_chatgpt', credentialStored: true, configFile: '/tmp/llm-providers.json',
        },
        {
          source: 'desktop-default', providerId: 'google', credentialId: 'credential-unsupported',
          displayName: 'Unsupported', model: 'model-c', baseUrl: 'https://c.example/v1',
          authMethod: 'oauth_google', credentialStored: true, configFile: '/tmp/llm-providers.json',
        },
      ],
      loadSharedSelection: (options) => ({
        source: 'desktop-default', providerId: 'openai',
        credentialId: options?.credentialId ?? 'credential-a', displayName: 'Provider',
        model: options?.credentialId === 'credential-b' ? 'model-b' : 'model-a',
        baseUrl: 'https://example.test/v1', authMethod: 'api_key', credentialStored: true,
        apiKey: 'hidden', configFile: '/tmp/llm-providers.json', persistOAuthTokens() {},
      }),
    });

    expect(config.providerId).toBe('credential-a');
    expect(config.catalog.map(({ providerId, modelId, displayName }) => ({
      providerId, modelId, displayName,
    }))).toEqual([
      { providerId: 'credential-a', modelId: 'model-a', displayName: 'model-a · Provider A' },
      { providerId: 'credential-b', modelId: 'model-b', displayName: 'model-b · Provider B' },
    ]);
    expect(config.resolveSharedSelection?.('credential-b')?.credentialId).toBe('credential-b');
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
    const config = resolveTuiModelConfig({}, {
      loadSharedMetadata: () => null,
      loadSharedMetadataList: () => [],
      loadSharedSelection: () => null,
    });
    const message = missingModelConfigurationMessage();

    expect(config.configured).toBe(false);
    expect(config.model).toBe('gpt-4o-mini');
    expect(await config.credentials.resolve({ providerId: 'openai-compatible' })).toBeNull();
    expect(message).toContain(TUI_MODEL_ENV.apiKey);
    expect(message).not.toContain('test-secret');
  });

  test('falls back to a catalog-supported desktop provider when the default auth is unsupported', () => {
    const config = resolveTuiModelConfig({}, {
      loadSharedMetadata: () => ({
        source: 'desktop-default', providerId: 'xai', credentialId: 'credential-grok',
        displayName: 'Grok', model: 'grok-4.5', baseUrl: 'https://grok.example',
        authMethod: 'oauth_grok', credentialStored: true, configFile: '/tmp/llm-providers.json',
      }),
      loadSharedMetadataList: () => [
        {
          source: 'desktop-default', providerId: 'xai', credentialId: 'credential-grok',
          displayName: 'Grok', model: 'grok-4.5', baseUrl: 'https://grok.example',
          authMethod: 'oauth_grok', credentialStored: true, configFile: '/tmp/llm-providers.json',
        },
        {
          source: 'desktop-default', providerId: 'openai', credentialId: 'credential-api',
          displayName: 'Idealab', model: 'gpt-test', baseUrl: 'https://api.example/v1',
          authMethod: 'api_key', credentialStored: true, configFile: '/tmp/llm-providers.json',
        },
      ],
      loadSharedSelection: () => null,
    });

    expect(config.configured).toBe(true);
    expect(config.source).toBe('desktop-default');
    expect(config.providerId).toBe('credential-api');
    expect(config.model).toBe('gpt-test');
    expect(config.catalog.map((entry) => entry.providerId)).toEqual(['credential-api']);
  });

});
