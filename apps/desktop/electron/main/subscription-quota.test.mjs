import assert from 'node:assert/strict';
import {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  fetchChatGptUsage,
  fetchGeminiQuota,
  fetchGrokQuota,
  fetchProviderSubscriptionQuota,
  supportsSubscriptionQuota,
} from './subscription-quota.mjs';

assert.equal(supportsSubscriptionQuota('oauth_chatgpt'), true);
assert.equal(supportsSubscriptionQuota('api_key'), false);

// GPT mock
{
  const payload = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 30, reset_at: 2000000000, limit_window_seconds: 10800 },
      secondary_window: { used_percent: 10, reset_at: 2000000000, limit_window_seconds: 604800 },
    },
  };
  const result = await fetchChatGptUsage({
    accessToken: 'tok',
    accountId: 'acc',
    fetchImpl: async (url, init) => {
      assert.match(String(url), /wham\/usage/);
      assert.equal(init.headers.Authorization, 'Bearer tok');
      assert.equal(init.headers['ChatGPT-Account-ID'], 'acc');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.remainingPercent, 70);
  assert.equal(result.windows.length, 2);
}

// Gemini mock
{
  const payload = {
    buckets: [
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.4, resetTime: '2026-07-20T00:00:00Z' },
      { modelId: 'gemini-2.5-flash', remainingFraction: 0.8, resetTime: '2026-07-20T00:00:00Z' },
    ],
  };
  const result = await fetchGeminiQuota({
    accessToken: 'tok',
    fetchImpl: async (url) => {
      if (String(url).includes('loadCodeAssist')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ cloudaicompanionProject: 'proj-1' }) };
      }
      assert.match(String(url), /retrieveUserQuota/);
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.remainingPercent, 40);
  assert.ok(result.windows.some((w) => w.id === 'gemini-2.5-pro'));
}

// Grok mock: build a trivial protobuf with float32 25.0 and timestamp
{
  // field 1 wire type 5 (fixed32) => key = (1<<3)|5 = 13
  const used = 25.0;
  const usedBuf = Buffer.alloc(4);
  usedBuf.writeFloatLE(used, 0);
  const message = Buffer.concat([Buffer.from([13]), usedBuf]);
  // grpc-web frame
  const frame = Buffer.alloc(5 + message.length);
  frame[0] = 0;
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);

  const result = await fetchGrokQuota({
    accessToken: 'tok',
    fetchImpl: async (url) => {
      assert.match(String(url), /GetGrokCreditsConfig/);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
      };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.usedPercent, 25);
  assert.equal(result.remainingPercent, 75);
}

// 上次成功额度：TTL 过期后 force=false 仍可先回缓存，便于 UI 静默刷新
{
  clearSubscriptionQuotaCache();
  let fetchCount = 0;
  const llmConfigStore = {
    listProviders: () => ([
      {
        id: 'gpt-1',
        authMethod: 'oauth_chatgpt',
        credentialId: 'cred-gpt',
        oauthStatus: { status: 'connected', accountId: 'acct-1' },
      },
    ]),
    getCredential: () => null,
  };
  const resolveCredential = async () => ({ apiKey: 'tok', accountId: 'acct-1' });
  const fetchImpl = async () => {
    fetchCount += 1;
    const payload = {
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 40 + fetchCount,
          reset_at: 2000000000,
          limit_window_seconds: 10800,
        },
      },
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };

  const first = await fetchProviderSubscriptionQuota({
    providerId: 'gpt-1',
    llmConfigStore,
    force: true,
    fetchImpl,
    resolveCredential,
  });
  assert.equal(first.success, true);
  assert.equal(first.usedPercent, 41);
  assert.equal(fetchCount, 1);

  // 新鲜 TTL 内 force=false 直接命中缓存
  const freshHit = await fetchProviderSubscriptionQuota({
    providerId: 'gpt-1',
    llmConfigStore,
    force: false,
    fetchImpl,
    resolveCredential,
  });
  assert.equal(freshHit.success, true);
  assert.equal(freshHit.cached, true);
  assert.equal(freshHit.usedPercent, 41);
  assert.equal(fetchCount, 1);

  // TTL 过期后仍回 lastSuccess，不重新请求
  expireFreshSubscriptionQuotaCache();
  const lastSuccessHit = await fetchProviderSubscriptionQuota({
    providerId: 'gpt-1',
    llmConfigStore,
    force: false,
    fetchImpl,
    resolveCredential,
  });
  assert.equal(lastSuccessHit.success, true);
  assert.equal(lastSuccessHit.cached, true);
  assert.equal(lastSuccessHit.usedPercent, 41);
  assert.equal(fetchCount, 1);

  // force=true 会重新请求并更新 lastSuccess
  const refreshed = await fetchProviderSubscriptionQuota({
    providerId: 'gpt-1',
    llmConfigStore,
    force: true,
    fetchImpl,
    resolveCredential,
  });
  assert.equal(refreshed.success, true);
  assert.equal(refreshed.usedPercent, 42);
  assert.equal(fetchCount, 2);
}

console.log('subscription-quota tests passed');
