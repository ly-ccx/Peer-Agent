import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import {
  SUBSCRIPTION_QUOTA_REFRESH_MS,
  formatQuotaLine,
  formatQuotaTooltipLine,
  formatResetAt,
  isOAuthMethod,
} from './llmSubscriptionQuota.ts';

describe('llmSubscriptionQuota', () => {
  it('refreshes subscription quota every 5 minutes', () => {
    assert.equal(SUBSCRIPTION_QUOTA_REFRESH_MS, 5 * 60 * 1000);
  });

  it('recognizes oauth subscription auth methods', () => {
    assert.equal(isOAuthMethod('oauth_chatgpt'), true);
    assert.equal(isOAuthMethod('oauth_google'), true);
    assert.equal(isOAuthMethod('oauth_grok'), true);
    assert.equal(isOAuthMethod('api_key'), false);
    assert.equal(isOAuthMethod(undefined), false);
  });

  it('formats remaining percent and reset time like settings', () => {
    const resetsAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const quota: LlmSubscriptionQuota = {
      success: true,
      remainingPercent: 72.4,
      resetsAt,
      planLabel: 'Plus',
    };
    const zh = formatQuotaLine(quota, true);
    const en = formatQuotaLine(quota, false);
    assert.ok(zh?.startsWith('剩余 72%'));
    assert.ok(zh?.includes('Plus'));
    assert.ok(zh?.includes('后重置'));
    assert.ok(en?.startsWith('72% left'));
    assert.ok(en?.includes('Plus'));
    assert.ok(en?.includes('resets in'));
  });

  it('formats failure states for settings line', () => {
    assert.equal(formatQuotaLine(undefined, true), null);
    assert.equal(
      formatQuotaLine({ success: false, status: 'not_logged_in' }, true),
      '未登录，无法查询额度',
    );
    assert.equal(
      formatQuotaLine({ success: false, status: 'session_expired' }, false),
      'Session expired — re-login',
    );
    assert.equal(formatQuotaLine({ success: false, status: 'unsupported' }, true), null);
  });

  it('builds chat tooltip line with remaining-quota label only on success', () => {
    const quota: LlmSubscriptionQuota = {
      success: true,
      remainingPercent: 50,
    };
    assert.equal(formatQuotaTooltipLine(quota, true), '剩余额度 50%');
    assert.equal(formatQuotaTooltipLine(quota, false), 'Usage remaining 50%');
    assert.equal(formatQuotaTooltipLine({ success: false, error: 'x' }, true), null);
  });

  it('formats reset-at edge cases', () => {
    assert.equal(formatResetAt(undefined, true), null);
    assert.equal(formatResetAt('not-a-date', true), null);
    assert.equal(formatResetAt(new Date(Date.now() - 1000).toISOString(), true), '已重置');
    assert.equal(formatResetAt(new Date(Date.now() - 1000).toISOString(), false), 'reset now');
  });
});
