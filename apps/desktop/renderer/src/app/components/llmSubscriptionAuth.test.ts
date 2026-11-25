import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmChannelDescriptor } from '@peer-agent/protocol';
import {
  availableOAuthMethods,
  shouldOpenOAuthModelCatalog,
  subscriptionLoginLabel,
} from './llmSubscriptionAuth.ts';

const googleChannel = {
  id: 'google-ai',
  label: 'Google AI / Gemini',
  legacyProvider: 'openai',
  defaultWire: 'gemini',
  allowedWires: ['gemini'],
  defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
  capabilities: { reasoning: { supported: false, paramStyle: 'none' }, promptCache: false, vision: true },
  authMethods: {
    api_key: { wire: 'gemini' },
  },
} satisfies LlmChannelDescriptor;

describe('Subscription auth UI', () => {
  it('keeps Gemini on API key authentication', () => {
    assert.deepEqual(availableOAuthMethods(googleChannel), []);
    assert.ok(googleChannel.authMethods.api_key);
  });

  it('uses an explicit subscription login call to action', () => {
    assert.equal(subscriptionLoginLabel('oauth_chatgpt', true), '登录 ChatGPT');
    assert.equal(subscriptionLoginLabel('oauth_chatgpt', false), 'Login with ChatGPT');
  });

  it('skips model selection when the provider already has a default model', () => {
    assert.equal(shouldOpenOAuthModelCatalog('grok-4', [{ id: 'grok-4' }]), false);
    assert.equal(shouldOpenOAuthModelCatalog('  ', [{ id: 'grok-4' }]), true);
    assert.equal(shouldOpenOAuthModelCatalog(null, []), false);
  });
});
