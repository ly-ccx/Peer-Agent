import { createAccountUsageTransport } from './account-usage-transport.mjs';
import { parseDeepSeekBalance, parseKimiUsage, parseOpenCodeUsage } from './account-usage-parsers.mjs';

import { parseGlmUsage } from './account-usage-glm.mjs';
import { parseMoonshotBalance, queryOpenRouterUsage } from './account-usage-balances.mjs';
import { queryMiniMaxUsage } from './account-usage-minimax.mjs';
import { bailianUsageAdapter } from './account-usage-bailian.mjs';

const adapters = new Map([
  ['aliyun-bailian', bailianUsageAdapter],
  ['minimax-cn', { origin: 'https://api.minimaxi.com', query: queryMiniMaxUsage }],
  ['minimax-global', { origin: 'https://api.minimax.io', query: queryMiniMaxUsage }],
  ['moonshot', { origins: ['https://api.moonshot.cn', 'https://api.moonshot.ai'], path: '/v1/users/me/balance', parse: parseMoonshotBalance }],
  ['openrouter', { origin: 'https://openrouter.ai', query: queryOpenRouterUsage }],
  ['glm-coding-plan-cn', { origin: 'https://open.bigmodel.cn', path: '/api/monitor/usage/quota/limit', parse: parseGlmUsage }],
  ['glm-coding-plan-global', { origin: 'https://api.z.ai', path: '/api/monitor/usage/quota/limit', parse: parseGlmUsage }],
  ['deepseek', { origin: 'https://api.deepseek.com', path: '/user/balance', parse: parseDeepSeekBalance }],
  ['kimi-coding-plan', { origin: 'https://api.kimi.com', path: '/coding/v1/usages', parse: parseKimiUsage }],
  ['opencode-go', { origin: 'https://opencode.ai', path: '/zen/go/v1/usage', parse: parseOpenCodeUsage }],
]);
const canonical = (id) => ['opencode-go-openai', 'opencode-go-anthropic'].includes(id) ? 'opencode-go' : id;

/** Only explicit channel identity selects a data source; never infer it from a URL. */
export function createAccountUsageAdapters(options = {}) {
  const transport = createAccountUsageTransport(options);
  return {
    clear: () => transport.clear(),
    supports: (channelId) => adapters.has(canonical(channelId)),
    async fetch(provider, { apiKey, force = false } = {}) {
      const channelId = canonical(provider.channelId);
      const adapter = adapters.get(channelId);
      const context = { providerId: provider.id, channelId, authMethod: provider.authMethod };
      if (!adapter || provider.authMethod !== 'api_key') return { ...context, success: false, status: 'unsupported' };
      let origin = adapter.origin;
      if (adapter.origins) {
        try { origin = adapter.origins.find((candidate) => candidate === new URL(provider.baseUrl).origin); } catch { /* rejected below */ }
        if (!origin) return { ...context, success: false, status: 'endpoint_not_supported' };
      }
      const query = (path) => transport.query({
        instanceId: provider.groupId ?? provider.id, channelId,
        baseUrl: provider.baseUrl, allowedOrigins: [origin], allowedEndpointOrigins: [adapter.endpointOrigin ?? origin],
        endpoint: (adapter.endpointOrigin ?? origin) + path, apiKey, force, ...adapter.request,
      });
      if (adapter.query) return { ...context, ...await adapter.query(query) };
      const result = await query(adapter.path);
      if (!result.success) return { ...context, success: false, status: result.status, ...(adapter.unavailable ? { unavailable: adapter.unavailable } : {}) };
      // Timestamp represents the response observation, not subsequent cache reads.
      const parsed = adapter.parse(result.data, result.fetchedAt);
      return { ...context, ...parsed, fetchedAt: new Date(result.fetchedAt).toISOString() };
    },
  };
}
