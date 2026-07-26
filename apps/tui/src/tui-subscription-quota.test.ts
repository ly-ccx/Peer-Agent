import { describe, expect, test } from 'bun:test';

import type { LlmSubscriptionQuota } from '@peer-agent/protocol';

import {
  formatTuiTopbarQuota,
  remainingPercentFromQuota,
  subscriptionQuotaColor,
  supportsTuiSubscriptionQuota,
} from './tui-subscription-quota.ts';
import { applyThemeScheme, COLOR, DARK_PALETTE } from './tui-theme.ts';

describe('tui subscription quota formatting', () => {
  test('supports only OAuth subscription auth methods', () => {
    expect(supportsTuiSubscriptionQuota('oauth_chatgpt')).toBe(true);
    expect(supportsTuiSubscriptionQuota('oauth_google')).toBe(true);
    expect(supportsTuiSubscriptionQuota('oauth_grok')).toBe(true);
    expect(supportsTuiSubscriptionQuota('api_key')).toBe(false);
    expect(supportsTuiSubscriptionQuota(undefined)).toBe(false);
  });

  test('remainingPercent prefers remaining over used', () => {
    expect(remainingPercentFromQuota({
      success: true,
      remainingPercent: 72.4,
      usedPercent: 40,
    })).toBe(72);
    expect(remainingPercentFromQuota({
      success: true,
      usedPercent: 28.2,
    })).toBe(72);
    expect(remainingPercentFromQuota({
      success: false,
      remainingPercent: 10,
    })).toBeUndefined();
  });

  test('formatTuiTopbarQuota is compact and locale-aware', () => {
    const quota: LlmSubscriptionQuota = {
      success: true,
      remainingPercent: 72.4,
      planLabel: 'plus',
    };
    expect(formatTuiTopbarQuota(quota, 'zh-CN')).toBe('剩余72% · plus');
    expect(formatTuiTopbarQuota(quota, 'en-US')).toBe('72% · plus');
    expect(formatTuiTopbarQuota({ success: true, remainingPercent: 8 }, 'zh-CN')).toBe('剩余8%');
    expect(formatTuiTopbarQuota({ success: false, remainingPercent: 8 }, 'zh-CN')).toBeNull();
  });

  test('subscriptionQuotaColor escalates at low remaining', () => {
    applyThemeScheme('dark');
    expect(subscriptionQuotaColor(undefined)).toBe(COLOR.muted);
    expect(subscriptionQuotaColor(50)).toBe(COLOR.success);
    expect(subscriptionQuotaColor(20)).toBe(COLOR.warning);
    expect(subscriptionQuotaColor(5)).toBe(COLOR.danger);
    expect(COLOR.success).toBe(DARK_PALETTE.success);
  });
});
