// Provider 连通性判定的纯逻辑（无 electron / 无网络依赖，可独立单测）。
//
// 职责边界：
// - 这里只做"给定已解密的 token / 已推导的 oauth 状态 → 结论"的纯映射。
// - 真正的解密(safeStorage)、落盘、远程探测留在 llm-config-store / provider-adapters。
// 这样存储层不必为了被测试而拉起 electron 运行时，也避免在多处散落订阅判定口径。

/**
 * 由已解密的订阅 token 推导对外可见的登录态（不泄漏 token 本身）。
 * @param {{ access?: string, expires?: number, accountId?: string } | null | undefined} tokens
 * @param {number} now 当前时间戳(ms)，便于测试注入
 * @returns {{ status: 'connected' | 'expired' | 'disconnected', accountId?: string, expiresAt?: string }}
 */
export function deriveOAuthStatus(tokens, now = Date.now()) {
  if (!tokens?.access) return { status: 'disconnected' };
  const expiresAt =
    typeof tokens.expires === 'number' ? new Date(tokens.expires).toISOString() : undefined;
  const status =
    typeof tokens.expires === 'number' && tokens.expires <= now ? 'expired' : 'connected';
  return { status, accountId: tokens.accountId, expiresAt };
}

/**
 * 订阅(ChatGPT OAuth)provider 的连通性测试结果。
 * 订阅不持有 apiKey，连通性以 OAuth 登录态为准；真正的远程模型探测走 `llm:models:list`。
 * @param {{ status: 'connected' | 'expired' | 'disconnected' } | undefined} oauthStatus
 * @param {string} [model]
 * @returns {{ success: boolean, model?: string, latencyMs?: number, error?: string }}
 */
export function resolveSubscriptionTestResult(oauthStatus, model) {
  if (oauthStatus?.status === 'connected') {
    return { success: true, model, latencyMs: 0 };
  }
  return {
    success: false,
    error: oauthStatus?.status === 'expired' ? 'oauth_session_expired' : 'oauth_not_logged_in',
  };
}
