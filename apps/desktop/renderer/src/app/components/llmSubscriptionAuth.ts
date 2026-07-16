import type { LlmAuthMethod, LlmChannelDescriptor } from '@peer-agent/protocol';

const OAUTH_METHODS = ['oauth_chatgpt', 'oauth_google', 'oauth_grok'] as const;

export function availableOAuthMethods(channel: LlmChannelDescriptor): LlmAuthMethod[] {
  return OAUTH_METHODS.filter((method) => Boolean(channel.authMethods?.[method]));
}

export function subscriptionLoginLabel(method: LlmAuthMethod, zh: boolean): string {
  if (method === 'oauth_google') return zh ? '使用 Google 订阅登录' : 'Login with Google Subscription';
  if (method === 'oauth_grok') return zh ? '登录 Grok' : 'Login with Grok';
  return zh ? '登录 ChatGPT' : 'Login with ChatGPT';
}
