import { ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { ensureFreshGoogleTokens } from './llm-oauth/google-oauth.mjs';

export function createProviderCredentialError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function getProviderCredentialErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'provider_credential_error';
}

export async function resolveProviderCredential({
  provider,
  llmConfigStore,
  ensureFreshChatGptTokens = ensureFreshTokens,
  ensureFreshGeminiTokens = ensureFreshGoogleTokens,
}) {
  if (!provider?.id) {
    throw createProviderCredentialError('provider_not_found');
  }

  const authMethod = provider.authMethod || 'api_key';

  if (authMethod === 'oauth_chatgpt') {
    const credential = llmConfigStore.getCredential(provider.id);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh, refreshed } = await ensureFreshChatGptTokens(tokens);
      if (refreshed) llmConfigStore.setOAuthTokens(provider.id, fresh);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: fresh.accountId || tokens.accountId || null,
      };
    } catch (error) {
      throw createProviderCredentialError('oauth_token_refresh_failed', error);
    }
  }

  if (authMethod === 'oauth_google') {
    const credential = llmConfigStore.getCredential(provider.id);
    const tokens = credential?.tokens || null;
    if (!tokens?.access) {
      throw createProviderCredentialError('oauth_not_logged_in');
    }
    try {
      const { tokens: fresh, refreshed } = await ensureFreshGeminiTokens(tokens, {
        clientId: credential?.oauthClientId,
        clientSecret: credential?.oauthClientSecret,
      });
      if (refreshed) llmConfigStore.setOAuthTokens(provider.id, fresh);
      return {
        authMethod,
        apiKey: fresh.access,
        accountId: fresh.accountId || tokens.accountId || null,
      };
    } catch (error) {
      throw createProviderCredentialError('oauth_token_refresh_failed', error);
    }
  }

  const apiKey = llmConfigStore.getDecryptedApiKey(provider.id);
  if (!apiKey) {
    throw createProviderCredentialError('api_key_not_found');
  }

  return { authMethod, apiKey, accountId: null };
}
