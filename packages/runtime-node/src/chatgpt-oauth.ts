import type { ChatGptOAuthTokens } from './shared-model-config.ts';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export async function refreshChatGptOAuthTokens(
  tokens: ChatGptOAuthTokens,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ChatGptOAuthTokens> {
  if (!tokens.refresh) throw new Error('chatgpt_oauth_refresh_token_missing');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh,
    }).toString(),
  });
  if (!response.ok) throw new Error(`chatgpt_oauth_refresh_failed:${response.status}`);
  const value = await response.json() as Record<string, unknown>;
  const access = typeof value.access_token === 'string' ? value.access_token : '';
  if (!access) throw new Error('chatgpt_oauth_refresh_missing_access_token');
  return {
    access,
    refresh: typeof value.refresh_token === 'string' ? value.refresh_token : tokens.refresh,
    expires: Date.now() + Number(value.expires_in ?? 3600) * 1000,
    accountId: typeof value.account_id === 'string' ? value.account_id : tokens.accountId,
  };
}
