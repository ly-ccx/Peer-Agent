import { ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { ensureFreshGoogleTokens } from './llm-oauth/google-oauth.mjs';
import { ensureFreshGrokTokens } from './llm-oauth/grok-oauth.mjs';
import { loadQoderAccessToken } from './provider-adapters/qoder-local-auth.mjs';

export function createProviderCredentialError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function getProviderCredentialErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'provider_credential_error';
}

function isOAuthAuthMethod(authMethod) {
  return authMethod === 'oauth_chatgpt'
    || authMethod === 'oauth_google'
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
  ensureFreshGeminiTokens = ensureFreshGoogleTokens,
  ensureFreshGrokAccessTokens = ensureFreshGrokTokens,
} = {}) {
  if (!llmConfigStore?.listProviders) return { attempted: 0, refreshed: 0 };

  const providers = llmConfigStore.listProviders() || [];
  const seenCredentialIds = new Set();
  const targets = [];

  for (const provider of providers) {
    if (!isOAuthAuthMethod(provider?.authMethod)) continue;
    if (provider?.oauthStatus?.status !== 'expired') continue;
    const credentialId = provider.credentialId || provider.id;
    if (!credentialId || seenCredentialIds.has(credentialId)) continue;
    seenCredentialIds.add(credentialId);
    targets.push({
      id: provider.id,
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
        ensureFreshGeminiTokens,
        ensureFreshGrokAccessTokens,
      });
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
  ensureFreshGeminiTokens = ensureFreshGoogleTokens,
  ensureFreshGrokAccessTokens = ensureFreshGrokTokens,
  loadQoderToken = loadQoderAccessToken,
}) {
  if (!provider?.id) {
    throw createProviderCredentialError('provider_not_found');
  }

  // 展开出的虚拟记录（订阅/多模型）其复合 id 在存储里不存在，凭证仍存于原始记录。
  // credentialId 指向原始记录 id；普通记录无此字段时回退到 provider.id，行为不变。
  const credentialId = provider.credentialId || provider.id;

  const authMethod = provider.authMethod || 'api_key';

  if (authMethod === 'qoder_local_auth' || authMethod === 'local_cli') {
    try {
      const token = await loadQoderToken();
      return { authMethod: 'qoder_local_auth', apiKey: token, accountId: null };
    } catch (error) {
      throw createProviderCredentialError(error?.code || 'qoder_auth_unavailable', error);
    }
  }

  if (authMethod === 'oauth_chatgpt') {
    const credential = llmConfigStore.getCredential(credentialId);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh, refreshed } = await ensureFreshChatGptTokens(tokens);
      if (refreshed) llmConfigStore.setOAuthTokens(credentialId, fresh);
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
      const { tokens: fresh, refreshed } = await ensureFreshGrokAccessTokens(tokens);
      if (refreshed) llmConfigStore.setOAuthTokens(credentialId, fresh);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: null,
      };
    } catch (error) {
      throw createProviderCredentialError('oauth_token_refresh_failed', error);
    }
  }

  if (authMethod === 'oauth_google') {
    const credential = llmConfigStore.getCredential(credentialId);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh, refreshed } = await ensureFreshGeminiTokens(tokens);
      if (refreshed) llmConfigStore.setOAuthTokens(credentialId, fresh);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: fresh.accountId || tokens.accountId || null,
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
