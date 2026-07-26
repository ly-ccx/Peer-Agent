import os from 'node:os';
import path from 'node:path';

import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import {
  loadSharedModelMetadataList,
  loadSharedModelSelection,
  refreshChatGptOAuthTokens,
  type SharedModelAuthMethod,
} from '@peer-agent/runtime-node';

import {
  ensureFreshGoogleTokensFromDesktop,
  ensureFreshGrokTokensFromDesktop,
} from './desktop-provider-adapters.ts';
import { createTuiSharedModelCredentialStore } from './model-credential-store.ts';
import type { TuiLocale } from './tui-language.ts';
import { COLOR } from './tui-theme.ts';

/** Align with Desktop settings auto-refresh cadence. */
export const TUI_SUBSCRIPTION_QUOTA_REFRESH_MS = 5 * 60 * 1000;

const OAUTH_METHODS = new Set<SharedModelAuthMethod>([
  'oauth_chatgpt',
  'oauth_google',
  'oauth_grok',
]);

export function defaultTuiUserDataPath(): string {
  return process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
}

export function supportsTuiSubscriptionQuota(
  authMethod: string | null | undefined,
): boolean {
  return Boolean(authMethod && OAUTH_METHODS.has(authMethod as SharedModelAuthMethod));
}

export function remainingPercentFromQuota(
  quota: LlmSubscriptionQuota | null | undefined,
): number | undefined {
  if (!quota?.success) return undefined;
  if (typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)) {
    return Math.min(100, Math.max(0, Math.round(quota.remainingPercent)));
  }
  if (typeof quota.usedPercent === 'number' && Number.isFinite(quota.usedPercent)) {
    return Math.min(100, Math.max(0, Math.round(100 - quota.usedPercent)));
  }
  return undefined;
}

/**
 * Compact topbar label for subscription quota.
 * Desktop settings: "剩余 72% · plan · 12h 后重置"
 * CLI topbar is width-constrained, so keep only remaining % (+ optional plan).
 */
export function formatTuiTopbarQuota(
  quota: LlmSubscriptionQuota | null | undefined,
  locale: TuiLocale = 'zh-CN',
): string | null {
  const remaining = remainingPercentFromQuota(quota);
  if (remaining == null) return null;
  const plan = typeof quota?.planLabel === 'string' && quota.planLabel.trim()
    ? quota.planLabel.trim()
    : '';
  if (locale === 'zh-CN') {
    return plan ? `剩余${remaining}% · ${plan}` : `剩余${remaining}%`;
  }
  return plan ? `${remaining}% · ${plan}` : `${remaining}%`;
}

export function subscriptionQuotaColor(remaining: number | undefined): string {
  if (remaining == null) return COLOR.muted;
  if (remaining <= 10) return COLOR.danger;
  if (remaining <= 30) return COLOR.warning;
  return COLOR.success;
}

export function resolveSharedAuthMethod(options: {
  readonly credentialId: string;
  readonly userDataPath?: string;
}): SharedModelAuthMethod | null {
  const userDataPath = options.userDataPath ?? defaultTuiUserDataPath();
  const providers = loadSharedModelMetadataList({ userDataPath });
  const hit = providers.find((provider) => provider.credentialId === options.credentialId);
  return hit?.authMethod ?? null;
}

type QuotaFetchers = {
  readonly fetchChatGptUsage: (args: {
    accessToken: string;
    accountId?: string | null;
    fetchImpl?: typeof fetch;
  }) => Promise<LlmSubscriptionQuota>;
  readonly fetchGeminiQuota: (args: {
    accessToken: string;
    projectId?: string | null;
    fetchImpl?: typeof fetch;
  }) => Promise<LlmSubscriptionQuota>;
  readonly fetchGrokQuota: (args: {
    accessToken: string;
    fetchImpl?: typeof fetch;
  }) => Promise<LlmSubscriptionQuota>;
};

async function loadQuotaFetchers(): Promise<QuotaFetchers> {
  // Reuse Desktop main-process fetchers (already unit-tested against provider payloads).
  // TUI already imports Desktop ESM adapters the same way for OAuth refresh.
  return import(
    // @ts-expect-error Desktop ESM module does not publish declarations.
    '../../desktop/electron/main/subscription-quota.mjs'
  ) as Promise<QuotaFetchers>;
}

export type FetchTuiSubscriptionQuotaOptions = {
  readonly credentialId: string;
  readonly userDataPath?: string;
  readonly fetchImpl?: typeof fetch;
  /** Optional injectors for tests. */
  readonly loadSelection?: typeof loadSharedModelSelection;
  readonly loadFetchers?: () => Promise<QuotaFetchers>;
  readonly refreshChatGpt?: typeof refreshChatGptOAuthTokens;
  readonly refreshGoogle?: typeof ensureFreshGoogleTokensFromDesktop;
  readonly refreshGrok?: typeof ensureFreshGrokTokensFromDesktop;
};

/**
 * Load OAuth credentials for the selected Desktop provider and fetch subscription quota.
 * Returns null when the provider is not a subscription (api_key / unsupported).
 */
export async function fetchTuiSubscriptionQuota(
  options: FetchTuiSubscriptionQuotaOptions,
): Promise<LlmSubscriptionQuota | null> {
  const userDataPath = options.userDataPath ?? defaultTuiUserDataPath();
  const credentialStore = createTuiSharedModelCredentialStore({ dataHome: userDataPath });
  const loadSelection = options.loadSelection ?? loadSharedModelSelection;
  const selection = loadSelection({
    userDataPath,
    credentialId: options.credentialId,
    credentialStore,
  });
  if (!selection) {
    return {
      success: false,
      status: 'not_logged_in',
      providerId: options.credentialId,
      error: 'Provider credentials not available',
    };
  }
  if (!supportsTuiSubscriptionQuota(selection.authMethod)) {
    return null;
  }

  let tokens = selection.oauthTokens;
  if (!tokens?.access) {
    return {
      success: false,
      status: 'not_logged_in',
      providerId: options.credentialId,
      authMethod: selection.authMethod as LlmSubscriptionQuota['authMethod'],
      error: 'OAuth tokens missing',
    };
  }

  const refreshChatGpt = options.refreshChatGpt ?? refreshChatGptOAuthTokens;
  const refreshGoogle = options.refreshGoogle ?? ensureFreshGoogleTokensFromDesktop;
  const refreshGrok = options.refreshGrok ?? ensureFreshGrokTokensFromDesktop;

  try {
    if (selection.authMethod === 'oauth_chatgpt') {
      tokens = await refreshChatGpt(tokens);
      selection.persistOAuthTokens(tokens);
    } else if (selection.authMethod === 'oauth_google') {
      tokens = await refreshGoogle(tokens);
      selection.persistOAuthTokens(tokens);
    } else if (selection.authMethod === 'oauth_grok') {
      const fresh = await refreshGrok(tokens, { fetchImpl: options.fetchImpl });
      tokens = fresh.tokens;
      selection.persistOAuthTokens(tokens);
    }
  } catch {
    // Keep going with the existing access token; quota endpoints will report auth failures.
  }

  if (!tokens?.access) {
    return {
      success: false,
      status: 'session_expired',
      providerId: options.credentialId,
      authMethod: selection.authMethod as LlmSubscriptionQuota['authMethod'],
      error: 'OAuth access token unavailable',
    };
  }

  const fetchers = await (options.loadFetchers ?? loadQuotaFetchers)();
  try {
    if (selection.authMethod === 'oauth_chatgpt') {
      return await fetchers.fetchChatGptUsage({
        accessToken: tokens.access,
        accountId: selection.accountId,
        fetchImpl: options.fetchImpl,
      });
    }
    if (selection.authMethod === 'oauth_google') {
      return await fetchers.fetchGeminiQuota({
        accessToken: tokens.access,
        projectId: selection.oauthProjectId,
        fetchImpl: options.fetchImpl,
      });
    }
    return await fetchers.fetchGrokQuota({
      accessToken: tokens.access,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /session_expired|oauth_session_expired|401|403/i.test(message)
      ? 'session_expired'
      : 'fetch_failed';
    return {
      success: false,
      status,
      providerId: options.credentialId,
      authMethod: selection.authMethod as LlmSubscriptionQuota['authMethod'],
      error: message,
    };
  }
}
