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
    const config = resolveTuiModelConfig(environment);

    expect(config.configured).toBe(true);
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

  test('uses a safe missing-config state without including a secret', async () => {
    const config = resolveTuiModelConfig({});
    const message = missingModelConfigurationMessage();

    expect(config.configured).toBe(false);
    expect(config.model).toBe('gpt-4o-mini');
    expect(await config.credentials.resolve({ providerId: 'openai-compatible' })).toBeNull();
    expect(message).toContain(TUI_MODEL_ENV.apiKey);
    expect(message).not.toContain('test-secret');
  });
});
