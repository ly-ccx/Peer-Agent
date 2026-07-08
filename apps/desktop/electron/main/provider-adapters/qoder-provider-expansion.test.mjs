import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QODER_MODEL_ID_SEPARATOR,
  isQoderLocalProvider,
  makeQoderModelProviderId,
  parseQoderModelProviderId,
  expandOneQoderProvider,
  expandQoderProviders,
} from './qoder-provider-expansion.mjs';

const QODER_PROVIDER = {
  id: 'qoder-1',
  groupId: 'qoder-1',
  name: 'Qoder CLI',
  authMethod: 'qoder_local_auth',
  channelId: 'qoder',
  baseUrl: 'https://qoder.local',
  model: 'ultimate',
  modelLabel: 'Ultimate',
  enabled: true,
  apiKeyConfigured: true,
  isDefault: true,
};

const CATALOG = [
  { id: 'auto', label: 'Auto', contextWindow: 180_000, maxOutputTokens: 32_768, supportsVision: true, supportsReasoning: false },
  { id: 'ultimate', label: 'Ultimate', contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsVision: true, supportsReasoning: true },
  { id: 'performance', label: 'Performance', contextWindow: 260_000, maxOutputTokens: 16_384, supportsVision: false, supportsReasoning: true },
];

describe('qoder-provider-expansion', () => {
  it('isQoderLocalProvider 认识两种 authMethod，拒绝其它', () => {
    assert.equal(isQoderLocalProvider({ authMethod: 'qoder_local_auth' }), true);
    assert.equal(isQoderLocalProvider({ authMethod: 'local_cli' }), true);
    assert.equal(isQoderLocalProvider({ authMethod: 'api_key' }), false);
    assert.equal(isQoderLocalProvider({}), false);
    assert.equal(isQoderLocalProvider(null), false);
  });

  it('复合 id 可往返编解码', () => {
    const id = makeQoderModelProviderId('qoder-1', 'performance');
    assert.equal(id, `qoder-1${QODER_MODEL_ID_SEPARATOR}performance`);
    assert.deepEqual(parseQoderModelProviderId(id), { groupId: 'qoder-1', modelId: 'performance' });
  });

  it('parseQoderModelProviderId 对非复合 id 返回 null', () => {
    assert.equal(parseQoderModelProviderId('qoder-1'), null);
    assert.equal(parseQoderModelProviderId('::performance'), null);
    assert.equal(parseQoderModelProviderId('qoder-1::'), null);
    assert.equal(parseQoderModelProviderId(''), null);
    assert.equal(parseQoderModelProviderId(null), null);
  });

  it('expandOneQoderProvider 把一条记录展开成目录里的全部模型', () => {
    const expanded = expandOneQoderProvider(QODER_PROVIDER, CATALOG);
    assert.equal(expanded.length, 3);
    // 每条都带唯一复合 id、同一 groupId、正确 model 名。
    const ids = expanded.map((p) => p.id);
    assert.deepEqual(new Set(ids).size, 3);
    for (const p of expanded) {
      assert.equal(p.groupId, 'qoder-1');
      const parsed = parseQoderModelProviderId(p.id);
      assert.equal(parsed.modelId, p.model);
    }
  });

  it('展开记录共享原凭证相关字段（鉴权可直接复用）', () => {
    const expanded = expandOneQoderProvider(QODER_PROVIDER, CATALOG);
    for (const p of expanded) {
      assert.equal(p.authMethod, 'qoder_local_auth');
      assert.equal(p.channelId, 'qoder');
      assert.equal(p.baseUrl, 'https://qoder.local');
      assert.equal(p.enabled, true);
      assert.equal(p.apiKeyConfigured, true);
    }
  });

  it('已配置 model 作为代表模型排首位，并独占 isDefault', () => {
    const expanded = expandOneQoderProvider(QODER_PROVIDER, CATALOG);
    assert.equal(expanded[0].model, 'ultimate'); // 原记录 model=ultimate
    assert.equal(expanded[0].isDefault, true);
    assert.equal(expanded.filter((p) => p.isDefault).length, 1);
  });

  it('原记录非默认时，没有任何虚拟记录被标为默认', () => {
    const expanded = expandOneQoderProvider({ ...QODER_PROVIDER, isDefault: false }, CATALOG);
    assert.equal(expanded.filter((p) => p.isDefault).length, 0);
  });

  it('原 model 不在目录时回退 catalog 的 isDefault 标记，再回退第一条', () => {
    const withFlag = [
      { id: 'auto', label: 'Auto' },
      { id: 'ultimate', label: 'Ultimate', isDefault: true },
    ];
    const expanded = expandOneQoderProvider({ ...QODER_PROVIDER, model: 'gone' }, withFlag);
    assert.equal(expanded[0].model, 'ultimate');

    const noFlag = [{ id: 'auto', label: 'Auto' }, { id: 'lite', label: 'Lite' }];
    const expanded2 = expandOneQoderProvider({ ...QODER_PROVIDER, model: 'gone', isDefault: false }, noFlag);
    assert.equal(expanded2[0].model, 'auto');
  });

  it('每条虚拟记录带上对应模型的能力字段', () => {
    const expanded = expandOneQoderProvider(QODER_PROVIDER, CATALOG);
    const perf = expanded.find((p) => p.model === 'performance');
    assert.equal(perf.modelLabel, 'Performance');
    assert.equal(perf.contextWindow, 260_000);
    assert.equal(perf.supportsReasoning, true);
    assert.equal(perf.supportsVision, false);
  });

  it('空目录时优雅降级为原单条记录', () => {
    assert.deepEqual(expandOneQoderProvider(QODER_PROVIDER, []), [QODER_PROVIDER]);
    assert.deepEqual(expandOneQoderProvider(QODER_PROVIDER, null), [QODER_PROVIDER]);
  });

  it('expandQoderProviders 透传非 Qoder、展开 Qoder', () => {
    const providers = [
      { id: 'openai-1', authMethod: 'api_key', model: 'gpt-4o' },
      QODER_PROVIDER,
    ];
    const out = expandQoderProviders(providers, () => CATALOG);
    assert.equal(out.length, 1 + 3);
    assert.equal(out[0].id, 'openai-1'); // 非 Qoder 原样透传
    assert.equal(out.filter((p) => p.groupId === 'qoder-1').length, 3);
  });

  it('expandQoderProviders 在 resolveCatalog 抛错时保留原记录', () => {
    const out = expandQoderProviders([QODER_PROVIDER], () => { throw new Error('boom'); });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'qoder-1');
  });
});
