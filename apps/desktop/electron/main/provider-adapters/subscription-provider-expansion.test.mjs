import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isSubscriptionProvider,
  expandOneSubscriptionProvider,
  expandSubscriptionProviders,
} from './subscription-provider-expansion.mjs';

const SUB_PROVIDER = {
  id: 'chatgpt-1',
  groupId: 'chatgpt-1',
  name: 'ChatGPT 订阅',
  authMethod: 'oauth_chatgpt',
  channelId: 'openai',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'gpt-5.5',
  modelLabel: 'GPT-5.5',
  enabled: true,
  apiKeyConfigured: true,
  isDefault: true,
  oauthStatus: { status: 'connected' },
};

const CATALOG = [
  { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 258_000, maxOutputTokens: 128_000, inputPrice: 5, outputPrice: 30, cacheReadPrice: 0.5 },
  { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 400_000, maxOutputTokens: 128_000, inputPrice: 0.75, outputPrice: 4.5, cacheReadPrice: 0.075, reasoningEffortLevels: ['low', 'default', 'high', 'max'] },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
];

const API_KEY_PROVIDER = {
  id: 'openai-key-1',
  groupId: 'openai-key-1',
  authMethod: 'api_key',
  model: 'gpt-4o',
  enabled: true,
  apiKeyConfigured: true,
};

describe('subscription-provider-expansion', () => {
  it('isSubscriptionProvider 只认 oauth_chatgpt', () => {
    assert.equal(isSubscriptionProvider({ authMethod: 'oauth_chatgpt' }), true);
    assert.equal(isSubscriptionProvider({ authMethod: 'oauth_google' }), false);
    assert.equal(isSubscriptionProvider({ authMethod: 'api_key' }), false);
    assert.equal(isSubscriptionProvider({}), false);
    assert.equal(isSubscriptionProvider(null), false);
  });

  it('把一条订阅记录展开成 catalog 条数的多条虚拟记录，id=groupId::modelId', () => {
    const out = expandOneSubscriptionProvider(SUB_PROVIDER, CATALOG);
    assert.equal(out.length, 3);
    const ids = out.map((r) => r.id).sort();
    assert.deepEqual(ids, ['chatgpt-1::gpt-5.3-codex-spark', 'chatgpt-1::gpt-5.4', 'chatgpt-1::gpt-5.5'].sort());
    for (const r of out) {
      assert.equal(r.groupId, 'chatgpt-1');
      assert.equal(r.credentialId, 'chatgpt-1'); // 凭证回退键指向原始记录 id
      assert.equal(r.authMethod, 'oauth_chatgpt');
    }
  });

  it('每条虚拟记录带正确 model/定价/上下文（取自 catalog）', () => {
    const out = expandOneSubscriptionProvider(SUB_PROVIDER, CATALOG);
    const m54 = out.find((r) => r.model === 'gpt-5.4');
    assert.ok(m54);
    assert.equal(m54.modelLabel, 'GPT-5.4');
    assert.equal(m54.contextWindow, 400_000);
    assert.equal(m54.inputPrice, 0.75);
    assert.equal(m54.outputPrice, 4.5);
    assert.deepEqual(m54.reasoningEffortLevels, ['low', 'default', 'high', 'max']);
  });

  it('代表模型（原记录已绑的 model）排首位并承接 isDefault，其余不制造新的全局默认', () => {
    const out = expandOneSubscriptionProvider(SUB_PROVIDER, CATALOG);
    assert.equal(out[0].model, 'gpt-5.5'); // 原绑定 gpt-5.5 → 代表模型排首位
    assert.equal(out[0].isDefault, true);
    assert.equal(out.filter((r) => r.isDefault).length, 1);
  });

  it('空 catalog / 非数组时优雅降级为原单条记录', () => {
    assert.deepEqual(expandOneSubscriptionProvider(SUB_PROVIDER, []), [SUB_PROVIDER]);
    assert.deepEqual(expandOneSubscriptionProvider(SUB_PROVIDER, null), [SUB_PROVIDER]);
  });

  it('列表级：非订阅记录原样透传，订阅记录被展开', () => {
    const out = expandSubscriptionProviders([API_KEY_PROVIDER, SUB_PROVIDER], () => CATALOG);
    // 1 条 api_key 原样 + 3 条订阅虚拟
    assert.equal(out.length, 4);
    assert.ok(out.includes(API_KEY_PROVIDER)); // 引用透传
    assert.equal(out.filter((r) => r.authMethod === 'oauth_chatgpt').length, 3);
  });

  it('resolveCatalog 抛错时该订阅记录降级为原单条（不丢记录）', () => {
    const out = expandSubscriptionProviders([SUB_PROVIDER], () => { throw new Error('boom'); });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'chatgpt-1');
  });
});
