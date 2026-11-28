import { retiredModelConfigCode } from '@peer-agent/runtime-node/storage';
import { ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { ensureFreshGrokTokens } from './llm-oauth/grok-oauth.mjs';

/** Stable business codes → user-facing text (chat bubble shows error.message). */
const PROVIDER_CREDENTIAL_ERROR_MESSAGES = {
  provider_not_found: 'Provider not found. Select an available model in Settings.',
  unsupported_provider: 'This model provider has been retired. Select an available model in Settings.',
  unsupported_auth_method: 'This sign-in method has been retired. Select an available model in Settings.',
  oauth_not_logged_in: 'OAuth is not logged in. Sign in again, then retry.',
  oauth_token_refresh_failed: 'OAuth token refresh failed. Sign in again, then retry.',
  api_key_not_found: 'API key is not configured for this provider.',
  provider_credential_error: 'Provider credential error.',
};

export function createProviderCredentialError(code, cause = null) {
  const message = PROVIDER_CREDENTIAL_ERROR_MESSAGES[code] || code;
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function getProviderCredentialErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'provider_credential_error';
}

/** Prefer readable Error.message for chat bubbles; never fall back to silent empty text. */
export function getProviderCredentialErrorMessage(error) {
  const code = getProviderCredentialErrorCode(error);
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message && message !== code) return message;
  return PROVIDER_CREDENTIAL_ERROR_MESSAGES[code] || message || code;
}

function isOAuthAuthMethod(authMethod) {
  return authMethod === 'oauth_chatgpt'
    || authMethod === 'oauth_grok';
}

/**
 * 设置页/渠道列表加载时，对 access 已过期但仍可能 refresh 的 OAuth 渠道静默续期。
 * 成功则写回 token（经 resolveProviderCredential → setOAuthTokens），失败时吞掉错误，
 * 让列表继续用本地 oauthStatus 投影（仍可能是 expired，需用户重登）。
 *
 * 只处理 status === 'expired'：connected 不必触网，disconnected 无 token 可刷。
 * 同一 credentialId 只刷新一次，避免订阅展开的多虚拟模型重复请求。
 */
export async function refreshExpiredOAuthProviders({
  llmConfigStore,
  resolveCredential = resolveProviderCredential,
  ensureFreshChatGptTokens = ensureFreshTokens,
  ensureFreshGrokAccessTokens = ensureFreshGrokTokens,
} = {}) {
  if (!llmConfigStore?.listProviders) return { attempted: 0, refreshed: 0 };

  const providers = llmConfigStore.listProviders() || [];
  const seenCredentialKeys = new Set();
  const targets = [];

  for (const provider of providers) {
    if (!isOAuthAuthMethod(provider?.authMethod)) continue;
    if (provider?.oauthStatus?.status !== 'expired') continue;
    const dedupeKey = provider.credentialId || provider.groupId || provider.id;
    const credentialId = provider.credentialId || provider.id;
    if (!dedupeKey || !credentialId || seenCredentialKeys.has(dedupeKey)) continue;
    seenCredentialKeys.add(dedupeKey);
    targets.push({
      id: provider.id,
      groupId: provider.groupId,
      credentialId,
      authMethod: provider.authMethod,
    });
  }

  let refreshed = 0;
  await Promise.all(targets.map(async (provider) => {
    try {
      await resolveCredential({
        provider,
        llmConfigStore,
        ensureFreshChatGptTokens,
        ensureFreshGrokAccessTokens,
      });
      // Only broadcast a list refresh when the persisted oauthStatus actually left
      // 'expired'; otherwise a stale hint would re-trigger list -> refresh in a loop.
      if (resolveCredential === resolveProviderCredential) {
        const latest = (llmConfigStore.listProviders() || []).find((item) => (
          item.id === provider.id
          || (provider.groupId && item.groupId === provider.groupId)
        ));
        if (latest?.oauthStatus?.status === 'expired') return;
      }
      refreshed += 1;
    } catch {
      // 列表路径不得因单个渠道 refresh 失败而整页报错；UI 继续展示 expired。
    }
  }));

  return { attempted: targets.length, refreshed };
}

export async function resolveProviderCredential({
  provider,
  llmConfigStore,
  ensureFreshChatGptTokens = ensureFreshTokens,
  ensureFreshGrokAccessTokens = ensureFreshGrokTokens,
}) {
  if (!provider?.id) {
    throw createProviderCredentialError('provider_not_found');
  }

  // 展开出的虚拟记录（订阅/多模型）其复合 id 在存储里不存在，凭证仍存于原始记录。
  // credentialId 指向原始记录 id；普通记录无此字段时回退到 provider.id，行为不变。
  const credentialId = provider.credentialId || provider.id;

  const retired = retiredModelConfigCode(provider);
  if (retired) throw createProviderCredentialError(retired);
  const authMethod = provider.authMethod || 'api_key';

  if (authMethod === 'oauth_chatgpt') {
    const credential = llmConfigStore.getCredential(credentialId);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh } = await llmConfigStore.refreshOAuthTokens(credentialId, tokens, ensureFreshChatGptTokens);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: fresh.accountId || tokens.accountId || null,
      };
    } catch (error) {
      throw createProviderCredentialError('oauth_token_refresh_failed', error);
    }
  }

  if (authMethod === 'oauth_grok') {
    const credential = llmConfigStore.getCredential(credentialId);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh } = await llmConfigStore.refreshOAuthTokens(credentialId, tokens, ensureFreshGrokAccessTokens);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: null,
      };
    } catch (error) {
      throw createProviderCredentialError('oauth_token_refresh_failed', error);
    }
  }

  const apiKey = llmConfigStore.getDecryptedApiKey(credentialId);
  if (!apiKey) {
    throw createProviderCredentialError('api_key_not_found');
  }

  return { authMethod, apiKey, accountId: null };
}
