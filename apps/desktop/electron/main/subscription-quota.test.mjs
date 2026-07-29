import assert from 'node:assert/strict';
import {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  fetchChatGptUsage,
  fetchGeminiQuota,
  fetchGrokQuota,
  fetchProviderSubscriptionQuota,
  fetchQoderQuota,
  mapQoderUsageToQuota,
  resolveGeminiCodeAssistProjectId,
  supportsSubscriptionQuota,
} from './subscription-quota.mjs';

assert.equal(supportsSubscriptionQuota('oauth_chatgpt'), true);
assert.equal(supportsSubscriptionQuota('qoder_local_auth'), true);
assert.equal(supportsSubscriptionQuota('local_cli'), true);
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


// Gemini Code Assist project resolution
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes('loadCodeAssist')) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: 'proj-from-load',
        currentTier: { id: 'free-tier' },
      }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const projectId = await resolveGeminiCodeAssistProjectId({
    accessToken: 'tok',
    fetchImpl,
  });
  assert.equal(projectId, 'proj-from-load');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /loadCodeAssist$/);
  assert.equal(calls[0].body.metadata.pluginType, 'GEMINI');
}

{
  const calls = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    if (href.includes('loadCodeAssist')) {
      return new Response(JSON.stringify({
        allowedTiers: [{ id: 'free-tier', isDefault: true }],
      }), { status: 200 });
    }
    if (href.includes('onboardUser')) {
      return new Response(JSON.stringify({
        name: 'operations/abc',
        done: false,
      }), { status: 200 });
    }
    if (href.includes('/operations/abc')) {
      return new Response(JSON.stringify({
        name: 'operations/abc',
        done: true,
        response: { cloudaicompanionProject: { id: 'proj-onboarded' } },
      }), { status: 200 });
    }
    throw new Error(`unexpected url ${href}`);
  };
  const projectId = await resolveGeminiCodeAssistProjectId({
    accessToken: 'tok',
    fetchImpl,
    pollIntervalMs: 0,
  });
  assert.equal(projectId, 'proj-onboarded');
  assert.equal(calls.some((c) => c.url.includes('onboardUser')), true);
  assert.equal(calls.some((c) => c.url.includes('/operations/abc')), true);
}


// network failure should surface, not silently return null
{
  let threw = false;
  try {
    await resolveGeminiCodeAssistProjectId({
      accessToken: 'tok',
      fetchImpl: async () => {
        throw new Error('fetch failed: ConnectTimeoutError');
      },
      pollIntervalMs: 0,
    });
  } catch (error) {
    threw = true;
    assert.match(String(error?.message || error), /loadCodeAssist 网络请求失败/);
  }
  assert.equal(threw, true);
}

// Qoder usage mapping: plan + org resource package credits
{
  const mapped = mapQoderUsageToQuota({
    userId: 'u-1',
    userType: 'Teams',
    expiresAt: '2026-08-23T00:00:00+08:00',
    userQuota: { used: 6000, total: 6000, remaining: 0, percentage: 100 },
    orgResourcePackage: { used: 7694, cap: 34000, remaining: 26306, percentage: 22.63 },
  });
  assert.equal(mapped.success, true);
  assert.equal(mapped.provider, 'qoder');
  assert.equal(mapped.planLabel, 'Teams');
  assert.equal(mapped.availableCredits, 26306);
  assert.equal(mapped.planCreditsUsed, 6000);
  assert.equal(mapped.planCreditsTotal, 6000);
  assert.equal(mapped.orgPackageUsed, 7694);
  assert.equal(mapped.orgPackageCap, 34000);
  assert.ok(mapped.windows?.some((window) => window.id === 'plan_credits'));
  assert.ok(mapped.windows?.some((window) => window.id === 'org_resource_package'));
  assert.equal(Math.round(mapped.remainingPercent), 66);
}

// Qoder quota loader injection
{
  const result = await fetchQoderQuota({
    usageLoader: async () => ({
      userType: 'Pro',
      userQuota: { used: 100, total: 1000, remaining: 900, percentage: 10 },
    }),
  });
  assert.equal(result.success, true);
  assert.equal(result.planLabel, 'Pro');
  assert.equal(result.availableCredits, 900);
  assert.equal(result.remainingPercent, 90);
}

// Qoder provider facade: method is accepted (not unsupported).
// When local Qoder CLI is logged in this may succeed; otherwise it must fail with a non-unsupported status.
{
  clearSubscriptionQuotaCache();
  const result = await fetchProviderSubscriptionQuota({
    providerId: 'qoder-1',
    force: true,
    llmConfigStore: {
      listProviders: () => ([{
        id: 'qoder-1',
        authMethod: 'qoder_local_auth',
        credentialId: 'qoder-cred',
      }]),
    },
  });
  assert.notEqual(result.status, 'unsupported');
  if (result.success) {
    assert.equal(result.provider, 'qoder');
    assert.equal(result.authMethod, 'qoder_local_auth');
  } else {
    assert.ok(['not_logged_in', 'fetch_failed', 'parse_failed', 'session_expired'].includes(result.status));
  }
}

console.log('subscription-quota tests passed');
