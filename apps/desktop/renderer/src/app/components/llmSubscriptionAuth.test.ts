import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmChannelDescriptor } from '@peer-agent/protocol';
import { availableOAuthMethods, subscriptionLoginLabel } from './llmSubscriptionAuth.ts';

const googleChannel = {
  id: 'google-ai',
  label: 'Google AI / Gemini',
  legacyProvider: 'openai',
  defaultWire: 'gemini',
  allowedWires: ['gemini'],
  defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
  capabilities: { reasoning: { supported: false, paramStyle: 'none' }, promptCache: false, vision: true },
  authMethods: {
    api_key: { wire: 'gemini' },
    oauth_google: { wire: 'gemini' },
  },
} satisfies LlmChannelDescriptor;

describe('Google subscription auth UI', () => {
  it('exposes Google subscription alongside API key', () => {
    assert.deepEqual(availableOAuthMethods(googleChannel), ['oauth_google']);
    assert.ok(googleChannel.authMethods.api_key);
  });

  it('uses an explicit Google subscription login call to action', () => {
    assert.equal(subscriptionLoginLabel('oauth_google', true), '使用 Google 订阅登录');
    assert.equal(subscriptionLoginLabel('oauth_google', false), 'Login with Google Subscription');
  });
});
