import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOAuthStatus, resolveSubscriptionTestResult } from './provider-connectivity.mjs';

// 回归核心命题：订阅(ChatGPT OAuth)provider 不持有 apiKey，
// 其连通性判定不得退化为 "API key not configured"，而应以 OAuth 登录态为准。

test('deriveOAuthStatus: 有效未过期 token => connected', () => {
  const now = 1_000_000;
  const status = deriveOAuthStatus({ access: 'a', expires: now + 60_000, accountId: 'acct' }, now);
  assert.equal(status.status, 'connected');
  assert.equal(status.accountId, 'acct');
});

test('deriveOAuthStatus: 已过期 token => expired', () => {
  const now = 1_000_000;
  const status = deriveOAuthStatus({ access: 'a', expires: now - 1 }, now);
  assert.equal(status.status, 'expired');
});

test('deriveOAuthStatus: 无 access => disconnected', () => {
  assert.equal(deriveOAuthStatus(null).status, 'disconnected');
  assert.equal(deriveOAuthStatus({}).status, 'disconnected');
});

test('resolveSubscriptionTestResult: connected => success, 不报 API key not configured', () => {
  const result = resolveSubscriptionTestResult({ status: 'connected' }, 'gpt-5');
  assert.equal(result.success, true);
  assert.equal(result.model, 'gpt-5');
  assert.notEqual(result.error, 'API key not configured');
});

test('resolveSubscriptionTestResult: expired => oauth_session_expired', () => {
  const result = resolveSubscriptionTestResult({ status: 'expired' }, 'gpt-5');
  assert.equal(result.success, false);
  assert.equal(result.error, 'oauth_session_expired');
});

test('resolveSubscriptionTestResult: disconnected/undefined => oauth_not_logged_in', () => {
  assert.equal(resolveSubscriptionTestResult({ status: 'disconnected' }).error, 'oauth_not_logged_in');
  assert.equal(resolveSubscriptionTestResult(undefined).error, 'oauth_not_logged_in');
});
