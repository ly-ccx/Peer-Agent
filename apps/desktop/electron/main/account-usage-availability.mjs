const policies = {
  openai: ['API 平台组织用量需要独立 Admin Key；ChatGPT OAuth 查询的是订阅额度', 'admin_key'],
  anthropic: ['组织用量需要独立 Admin Key；Claude 订阅需要独立登录态', 'admin_key'],
  'google-ai': ['普通 Gemini API Key 无法查询 OAuth Code Assist 账户额度', 'oauth'],
  'volcengine-ark': ['计划用量需要额外 arkcli 登录；不会发送收费推理请求探测限流', 'cli_login'],
  'xiaomi-mimo': ['账户余额需要 MiMo 控制台会话', 'web_session'],
  'xiaomi-mimo-token-plan': ['Token Plan 账户数据需要 MiMo 控制台会话', 'web_session'],
  'aliyun-bailian': ['API Key 额度查询为 best-effort；控制台会话路径不在本阶段范围', 'web_session'],
  'minimax-cn': ['计划额度需要本区域 Token/Coding Plan Key；普通推理 Key 不保证支持', 'coding_plan_key'],
  'minimax-global': ['计划额度需要本区域 Token/Coding Plan Key；普通推理 Key 不保证支持', 'coding_plan_key'],
  moonshot: ['余额查询需要当前渠道的 API Key'],
  openrouter: ['余额与 Key 消费查询需要当前渠道的 API Key'],
  'openai-compatible': ['自定义服务没有统一账户接口；仅提供 Peer Agent 本地统计'],
  'anthropic-compatible': ['自定义服务没有统一账户接口；仅提供 Peer Agent 本地统计'],
};

/** Describes current implementation, not a claim that a vendor can never support it. */
export function unavailableAccountUsage(channelId) {
  const [reason, requiredAuth] = policies[channelId] ?? ['当前渠道与认证组合尚无已接通的数据源'];
  return {
    success: false, status: 'unsupported',
    unavailable: ['balance', 'windows', 'spend'].map((dimension) => ({ dimension, reason, ...(requiredAuth ? { requiredAuth } : {}) })),
  };
}
