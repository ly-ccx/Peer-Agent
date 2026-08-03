import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderError,
  deriveOAuthStatus,
  enrichTestResultWithDiagnostics,
  resolveSubscriptionTestResult,
  sanitizeDiagnosticDetail,
} from './provider-connectivity.mjs';

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
  assert.equal(result.connectionState, 'available');
  assert.ok(Array.isArray(result.stages));
  assert.ok(result.diagnostic);
});

test('resolveSubscriptionTestResult: expired => oauth_session_expired', () => {
  const result = resolveSubscriptionTestResult({ status: 'expired' }, 'gpt-5');
  assert.equal(result.success, false);
  assert.equal(result.error, 'oauth_session_expired');
  assert.equal(result.errorCategory, 'auth_expired');
  assert.equal(result.connectionState, 'needs_attention');
});

test('resolveSubscriptionTestResult: disconnected/undefined => oauth_not_logged_in', () => {
  assert.equal(resolveSubscriptionTestResult({ status: 'disconnected' }).error, 'oauth_not_logged_in');
  assert.equal(resolveSubscriptionTestResult(undefined).error, 'oauth_not_logged_in');
});

test('classifyProviderError maps common failures', () => {
  assert.equal(classifyProviderError('API key not configured'), 'credential_missing');
  assert.equal(classifyProviderError('HTTP 401: unauthorized'), 'credential_invalid');
  assert.equal(classifyProviderError('HTTP 429 rate limit'), 'rate_limited');
  assert.equal(classifyProviderError('ECONNREFUSED'), 'endpoint_unreachable');
});

test('enrichTestResultWithDiagnostics adds stages on success/failure', () => {
  const ok = enrichTestResultWithDiagnostics({ success: true, model: 'gpt', latencyMs: 12 });
  assert.equal(ok.connectionState, 'available');
  assert.equal(ok.stages.find((s) => s.id === 'min_inference')?.status, 'passed');

  const bad = enrichTestResultWithDiagnostics(
    { success: false, error: 'API key not configured' },
    { hasApiKey: false },
  );
  assert.equal(bad.errorCategory, 'credential_missing');
  assert.equal(bad.connectionState, 'needs_attention');
  assert.ok(bad.diagnostic?.suggestedActions?.length);
});

test('sanitizeDiagnosticDetail redacts secrets', () => {
  const text = sanitizeDiagnosticDetail('Bearer sk-abcdefghijklmnopqrstuvwxyz Authorization');
  assert.equal(text.includes('sk-abcdefghijklmnop'), false);
  assert.ok(text.includes('***'));
});
