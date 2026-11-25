import os from 'node:os';
import path from 'node:path';

import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import {
  fetchChatGptUsage,
  fetchGrokQuota,
  loadSharedModelMetadataList,
  loadSharedModelSelection,
  refreshChatGptOAuthTokens,
  type SharedModelAuthMethod,
} from '@peer-agent/runtime-node';

import {
  ensureFreshGrokTokensFromDesktop,
} from './desktop-provider-adapters.ts';
import { createTuiSharedModelCredentialStore } from './model-credential-store.ts';
import { createTuiProviderFetch, createTuiOAuthRefreshFetch } from './provider-transport.ts';
import type { TuiLocale } from './tui-language.ts';
import { COLOR } from './tui-theme.ts';

/** Align with Desktop settings auto-refresh cadence. */
export const TUI_SUBSCRIPTION_QUOTA_REFRESH_MS = 5 * 60 * 1000;

const OAUTH_METHODS = new Set<SharedModelAuthMethod>([
  'oauth_chatgpt',
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
  readonly fetchGrokQuota: (args: {
    accessToken: string;
    fetchImpl?: typeof fetch;
  }) => Promise<LlmSubscriptionQuota>;
};


/**
 * Use the same system-proxy + trusted-CA fetch path as TUI model calls.
 * Bare globalThis.fetch fails under macOS system proxy / corporate MITM CAs.
 */
function createQuotaFetchImpl(): typeof fetch {
  return createTuiProviderFetch();
}

async function loadQuotaFetchers(): Promise<QuotaFetchers> {
  return {
    fetchChatGptUsage,
    fetchGrokQuota,
  };
}

export type FetchTuiSubscriptionQuotaOptions = {
  readonly credentialId: string;
  readonly userDataPath?: string;
  readonly fetchImpl?: typeof fetch;
  /** Optional injectors for tests. */
  readonly loadSelection?: typeof loadSharedModelSelection;
  readonly loadFetchers?: () => Promise<QuotaFetchers>;
  readonly refreshChatGpt?: typeof refreshChatGptOAuthTokens;
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
  const refreshGrok = options.refreshGrok ?? ensureFreshGrokTokensFromDesktop;
  const refreshFetch = createTuiOAuthRefreshFetch(options.fetchImpl ? { fetch: options.fetchImpl } : {});

  try {
    const result = await selection.refreshOAuthTokens(tokens, async (current) => {
      if (selection.authMethod === 'oauth_chatgpt') {
        return { tokens: await refreshChatGpt(current, refreshFetch), refreshed: true };
      }
      return refreshGrok(current, { fetchImpl: refreshFetch });
    });
    tokens = result.tokens;
  } catch {
    // A pending refresh or changed generation cannot fall back to pre-read access.
    return { success: false, status: 'fetch_failed', providerId: options.credentialId,
      authMethod: selection.authMethod as LlmSubscriptionQuota['authMethod'], error: 'OAuth credentials require recovery' };
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
        fetchImpl: options.fetchImpl ?? createQuotaFetchImpl(),
      });
    }
    return await fetchers.fetchGrokQuota({
      accessToken: tokens.access,
      fetchImpl: options.fetchImpl ?? createQuotaFetchImpl(),
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
