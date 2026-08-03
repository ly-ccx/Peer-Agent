import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTokenBuckets,
  aggregateRequestUsage,
  buildProviderIndex,
  buildUsageStatsSnapshot,
  emptyTokenBucket,
  estimateUsageCostUsd,
  readLifetimeUsage,
} from './usage-stats.mjs';

test('readLifetimeUsage normalizes missing fields', () => {
  assert.deepEqual(readLifetimeUsage({}), emptyTokenBucket());
  assert.deepEqual(
    readLifetimeUsage({
      lifetimeUsage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    }),
    {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 16,
    },
  );
});

test('estimateUsageCostUsd uses USD per 1M tokens', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 200_000,
    cacheWriteTokens: 100_000,
  };
  const { estimatedCostUsd, hasPricing } = estimateUsageCostUsd(usage, {
    inputPrice: 5,
    outputPrice: 15,
    cacheReadPrice: 0.5,
    cacheWritePrice: 6.25,
  });
  assert.equal(hasPricing, true);
  // 5 + 7.5 + 0.1 + 0.625 = 13.225
  assert.ok(Math.abs(estimatedCostUsd - 13.225) < 1e-9);
});

test('estimateUsageCostUsd returns null without any price', () => {
  const result = estimateUsageCostUsd(
    { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    {},
  );
  assert.equal(result.hasPricing, false);
  assert.equal(result.estimatedCostUsd, null);
});

test('buildUsageStatsSnapshot aggregates across conversations by provider and model', () => {
  const snapshot = buildUsageStatsSnapshot({
    generatedAt: '2026-07-18T00:00:00.000Z',
    providers: [
      {
        id: 'openai::gpt-4o',
        groupId: 'openai',
        name: 'OpenAI',
        model: 'gpt-4o',
        inputPrice: 2.5,
        outputPrice: 10,
        cacheReadPrice: 1.25,
        cacheWritePrice: 0,
      },
      {
        id: 'openai::o3',
        groupId: 'openai',
        name: 'OpenAI',
        model: 'o3',
        inputPrice: 10,
        outputPrice: 40,
      },
    ],
    conversations: [
      {
        id: 'c1',
        modelProviderId: 'openai::gpt-4o',
        model: 'gpt-4o',
        lifetimeUsage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      {
        id: 'c2',
        modelProviderId: 'openai::o3',
        model: 'o3',
        lifetimeUsage: {
          inputTokens: 0,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      {
        id: 'c3',
        modelProviderId: null,
        lifetimeUsage: {
          inputTokens: 100,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    ],
  });

  assert.equal(snapshot.totals.conversationCount, 3);
  assert.equal(snapshot.totals.inputTokens, 1_000_100);
  assert.equal(snapshot.totals.outputTokens, 1_000_000);
  assert.equal(snapshot.totals.pricedConversationCount, 2);
  // 2.5 (1M input @2.5) + 40 (1M output @40) = 42.5
  assert.ok(Math.abs(snapshot.totals.estimatedCostUsd - 42.5) < 1e-9);

  const openai = snapshot.byProvider.find((row) => row.key === 'openai');
  assert.ok(openai);
  assert.equal(openai.conversationCount, 2);
  assert.equal(openai.inputTokens, 1_000_000);
  assert.equal(openai.outputTokens, 1_000_000);
  assert.ok(Math.abs(openai.estimatedCostUsd - 42.5) < 1e-9);

  assert.equal(snapshot.byModel.length, 3);
  const o3 = snapshot.byModel.find((row) => row.model === 'o3');
  assert.ok(o3);
  assert.ok(Math.abs(o3.estimatedCostUsd - 40) < 1e-9);
  assert.equal(snapshot.notes.unpricedConversationCount, 1);

  const unbound = snapshot.byProvider.find((row) => row.key === 'unbound');
  assert.ok(unbound);
  assert.equal(unbound.label, '未绑定 Provider');
  assert.equal(unbound.conversationCount, 1);
  const unboundModel = snapshot.byModel.find((row) => row.model === '未绑定模型');
  assert.ok(unboundModel);
  assert.equal(unboundModel.providerName, '未绑定 Provider');
});

test('buildUsageStatsSnapshot resolves id / groupId / groupId::model shapes', () => {
  const groupId = '5198c365-98ac-48f6-a5d0-29067ce63e42';
  const modelEntryId = '32ddcdf4-9cbd-4ca6-87b1-f3d596cc25d9';
  const snapshot = buildUsageStatsSnapshot({
    generatedAt: '2026-07-18T00:00:00.000Z',
    providers: [
      {
        id: groupId,
        groupId,
        name: 'ChatGPT 订阅',
        model: 'gpt-5.6-sol',
        modelLabel: 'GPT-5.6 Sol',
        inputPrice: 1,
        outputPrice: 2,
      },
      {
        id: modelEntryId,
        groupId,
        name: 'ChatGPT 订阅',
        model: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        inputPrice: 3,
        outputPrice: 4,
      },
      {
        id: '4cbe42eb-ddec-43d9-8969-a9acf381230d',
        groupId: '4cbe42eb-ddec-43d9-8969-a9acf381230d',
        name: 'Qoder CLI',
        model: 'ultimate',
        modelLabel: 'Ultimate',
        inputPrice: 0,
        outputPrice: 0,
      },
    ],
    conversations: [
      {
        id: 'by-composite',
        modelProviderId: `${groupId}::gpt-5.5`,
        lifetimeUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        id: 'by-entry-id',
        modelProviderId: modelEntryId,
        lifetimeUsage: { inputTokens: 0, outputTokens: 1_000_000 },
      },
      {
        id: 'by-group-id',
        modelProviderId: groupId,
        lifetimeUsage: { inputTokens: 100, outputTokens: 0 },
      },
      {
        id: 'by-composite-model-only-in-id',
        modelProviderId: '4cbe42eb-ddec-43d9-8969-a9acf381230d::ultimate',
        lifetimeUsage: { inputTokens: 10, outputTokens: 0 },
      },
    ],
  });

  const chatgpt = snapshot.byProvider.find((row) => row.key === groupId);
  assert.ok(chatgpt);
  assert.equal(chatgpt.label, 'ChatGPT 订阅');
  assert.equal(chatgpt.conversationCount, 3);

  // groupId::gpt-5.5 与模型条目 id 合并到同一稳定 key
  const gpt55 = snapshot.byModel.find((row) => row.key === `${groupId}::gpt-5.5`);
  assert.ok(gpt55);
  assert.equal(gpt55.label, 'GPT-5.5');
  assert.equal(gpt55.providerName, 'ChatGPT 订阅');
  assert.equal(gpt55.conversationCount, 2);
  assert.ok(Math.abs(gpt55.estimatedCostUsd - 7) < 1e-9);
  assert.equal(snapshot.byModel.filter((row) => row.label === 'GPT-5.5').length, 1);

  // 仅 groupId 绑定时回落渠道默认模型
  const byGroupDefault = snapshot.byModel.find((row) => row.key === `${groupId}::gpt-5.6-sol`);
  assert.ok(byGroupDefault);
  assert.equal(byGroupDefault.label, 'GPT-5.6 Sol');
  assert.equal(byGroupDefault.providerName, 'ChatGPT 订阅');
  assert.equal(byGroupDefault.conversationCount, 1);

  const qoder = snapshot.byProvider.find((row) => row.key === '4cbe42eb-ddec-43d9-8969-a9acf381230d');
  assert.ok(qoder);
  assert.equal(qoder.label, 'Qoder CLI');
  const ultimate = snapshot.byModel.find(
    (row) => row.key === '4cbe42eb-ddec-43d9-8969-a9acf381230d::ultimate',
  );
  assert.ok(ultimate);
  assert.equal(ultimate.label, 'Ultimate');

  // 友好文案：不再默认落到 unknown / Unknown provider。
  assert.equal(snapshot.byProvider.some((row) => row.label === 'Unknown provider'), false);
  assert.equal(snapshot.byModel.some((row) => row.label === 'unknown'), false);
});

test('buildUsageStatsSnapshot merges groupId and groupId::model for same model', () => {
  const groupId = '5198c365-98ac-48f6-a5d0-29067ce63e42';
  const snapshot = buildUsageStatsSnapshot({
    generatedAt: '2026-07-18T00:00:00.000Z',
    providers: [
      {
        id: groupId,
        groupId,
        name: 'ChatGPT 订阅',
        model: 'gpt-5.6-sol',
        modelLabel: 'GPT-5.6 Sol',
        inputPrice: 1,
        outputPrice: 2,
      },
    ],
    conversations: [
      {
        id: 'bind-group-only',
        modelProviderId: groupId,
        lifetimeUsage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        id: 'bind-composite',
        modelProviderId: `${groupId}::gpt-5.6-sol`,
        lifetimeUsage: { inputTokens: 2_000_000, outputTokens: 0 },
      },
      {
        id: 'bind-other-model',
        modelProviderId: `${groupId}::gpt-5.5`,
        lifetimeUsage: { inputTokens: 500_000, outputTokens: 0 },
      },
    ],
  });

  const merged = snapshot.byModel.find((row) => row.key === `${groupId}::gpt-5.6-sol`);
  assert.ok(merged);
  assert.equal(merged.label, 'GPT-5.6 Sol');
  assert.equal(merged.conversationCount, 2);
  assert.equal(merged.inputTokens, 3_000_000);
  assert.ok(Math.abs(merged.estimatedCostUsd - 3) < 1e-9);

  // 不应再出现以原始 modelProviderId 为 key 的重复行
  assert.equal(snapshot.byModel.filter((row) => row.key === groupId).length, 0);
  assert.equal(
    snapshot.byModel.filter((row) => row.label === 'GPT-5.6 Sol').length,
    1,
  );

  const other = snapshot.byModel.find((row) => row.key === `${groupId}::gpt-5.5`);
  assert.ok(other);
  assert.equal(other.conversationCount, 1);
  assert.equal(other.inputTokens, 500_000);
});

test('addTokenBuckets is pure and additive', () => {
  const sum = addTokenBuckets(
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10 },
    { inputTokens: 9, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: 6, totalTokens: 30 },
  );
  assert.deepEqual(sum, {
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 10,
    cacheWriteTokens: 10,
    totalTokens: 40,
  });
});

test('aggregateRequestUsage groups by provider and model with per-request cost', () => {
  const requests = [
    {
      conversationId: 'c1',
      modelProviderId: 'gpt-sub::gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      providerName: 'ChatGPT 订阅',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      estimatedCostUsd: 0.05,
      pricingSource: 'models.dev-reference',
    },
    {
      conversationId: 'c1',
      modelProviderId: 'gpt-sub::gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      providerName: 'ChatGPT 订阅',
      inputTokens: 2000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2300,
      estimatedCostUsd: 0.08,
    },
    {
      conversationId: 'c2',
      modelProviderId: 'deepseek::deepseek-v4',
      model: 'deepseek-v4',
      providerName: 'DeepSeek',
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 450,
      estimatedCostUsd: 0.002,
    },
  ];

  const { byModel, byProvider, estimatedCostUsd, requestCount } = aggregateRequestUsage(requests);

  assert.equal(requestCount, 3);
  assert.ok(Math.abs(estimatedCostUsd - 0.132) < 1e-9);

  const gpt = byModel.get('gpt-sub::gpt-5.6-sol');
  const deepseek = byModel.get('deepseek::deepseek-v4');
  assert.ok(gpt);
  assert.equal(gpt.requestCount, 2);
  assert.equal(gpt.inputTokens, 3000);
  assert.ok(Math.abs(gpt.estimatedCostUsd - 0.13) < 1e-9);
  assert.equal(gpt.label, 'gpt-5.6-sol');

  assert.ok(deepseek);
  assert.equal(deepseek.requestCount, 1);
  assert.equal(deepseek.inputTokens, 300);
  assert.ok(Math.abs(deepseek.estimatedCostUsd - 0.002) < 1e-9);

  // Provider 维度：两个 provider 各自一行。
  assert.equal(byProvider.size, 2);
  const gptProvider = byProvider.get('gpt-sub');
  assert.ok(gptProvider);
  assert.equal(gptProvider.label, 'ChatGPT 订阅');
});

test('buildUsageStatsSnapshot prefers request snapshot over lifetime estimate', () => {
  // conversations 故意用「当前绑定 DeepSeek」+ 错误累计，验证请求级快照不被其污染。
  const snapshot = buildUsageStatsSnapshot({
    generatedAt: '2026-07-18T00:00:00.000Z',
    providers: [{ id: 'deepseek', groupId: 'deepseek', name: 'DeepSeek', model: 'deepseek-v4', inputPrice: 1, outputPrice: 2 }],
    conversations: [
      {
        id: 'c1',
        modelProviderId: 'deepseek::deepseek-v4',
        model: 'deepseek-v4',
        lifetimeUsage: { inputTokens: 100_000, outputTokens: 0 },
      },
    ],
    requests: [
      {
        conversationId: 'c1',
        modelProviderId: 'gpt-sub::gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        providerName: 'ChatGPT 订阅',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1500,
        estimatedCostUsd: 0.05,
        pricingSource: 'models.dev-reference',
      },
    ],
  });

  assert.equal(snapshot.notes.scope, 'request_snapshot');
  assert.equal(snapshot.notes.requestCount, 1);
  assert.ok(Math.abs(snapshot.totals.estimatedCostUsd - 0.05) < 1e-9);
  assert.equal(snapshot.totals.inputTokens, 1000, 'tokens come from request snapshot, not lifetimeUsage');

  const byModel = snapshot.byModel.find((row) => row.key === 'gpt-sub::gpt-5.6-sol');
  assert.ok(byModel, 'request model row present');
  assert.equal(byModel.label, 'gpt-5.6-sol');
  assert.equal(byModel.inputTokens, 1000);

  // 不得出现 deepseek 的串账行（conversations 绑定了 deepseek 且有 lifetimeUsage）。
  const deepseekRows = snapshot.byModel.filter((row) => row.providerName === 'DeepSeek');
  assert.equal(deepseekRows.length, 0);
});

test('aggregateRequestUsage merges bare-uuid rows into one channel row via provider index (方案 A)', () => {
  // 历史快照 modelProviderId 是裸 uuid（模型条目 id），同一渠道多个模型条目
  // 必须归一到渠道 groupId，而不是每个 uuid 各占一行。
  const providers = [
    { id: 'uuid-ultimate', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'ultimate' },
    { id: 'uuid-cmodel', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'cmodel' },
  ];
  const requests = [
    { modelProviderId: 'uuid-ultimate', model: 'ultimate', providerName: 'Qoder CLI', inputTokens: 100, outputTokens: 10 },
    { modelProviderId: 'uuid-cmodel', model: 'cmodel', providerName: 'Qoder CLI', inputTokens: 200, outputTokens: 20 },
  ];

  const { byProvider, byModel } = aggregateRequestUsage(requests, {
    providerIndex: buildProviderIndex(providers),
  });

  assert.equal(byProvider.size, 1, '同一渠道只出一行');
  const row = byProvider.get('qoder-cli');
  assert.ok(row, 'provider 行以渠道 groupId 为键');
  assert.equal(row.inputTokens, 300);
  assert.equal(row.outputTokens, 30);
  assert.equal(row.requestCount, 2);

  // 模型维度保持按条目拆分，不受渠道归组影响。
  assert.equal(byModel.size, 2);
});

test('aggregateRequestUsage prefers written groupId over provider index (方案 B)', () => {
  const requests = [
    { modelProviderId: 'uuid-x', groupId: 'qoder-cli', model: 'ultimate', inputTokens: 10 },
    { modelProviderId: 'uuid-y', groupId: 'qoder-cli', model: 'cmodel', inputTokens: 20 },
  ];
  const { byProvider } = aggregateRequestUsage(requests);
  assert.equal(byProvider.size, 1);
  assert.equal(byProvider.get('qoder-cli').inputTokens, 30);
});

test('aggregateRequestUsage falls back to raw id when uuid not in current providers', () => {
  // 渠道已删除 / 索引缺失时，历史行回退原 key，不丢行、不串账。
  const requests = [
    { modelProviderId: 'legacy-uuid', model: 'old-model', inputTokens: 5 },
  ];
  const { byProvider } = aggregateRequestUsage(requests, {
    providerIndex: buildProviderIndex([]),
  });
  assert.equal(byProvider.size, 1);
  assert.ok(byProvider.get('legacy-uuid'), '未匹配索引时保留原 key');
});

test('buildUsageStatsSnapshot collapses Qoder CLI uuid rows into a single provider row', () => {
  const snapshot = buildUsageStatsSnapshot({
    generatedAt: '2026-08-03T00:00:00.000Z',
    providers: [
      { id: 'uuid-ultimate', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'ultimate' },
      { id: 'uuid-cmodel', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'cmodel' },
      { id: 'gemini-entry', groupId: 'gemini-oauth', name: 'Gemini OAuth', model: 'gemini-3.1-flash-lite', inputPrice: 1 },
    ],
    conversations: [],
    requests: [
      { modelProviderId: 'uuid-ultimate', model: 'ultimate', providerName: 'Qoder CLI', inputTokens: 205_000_000, outputTokens: 900_000 },
      { modelProviderId: 'uuid-cmodel', model: 'cmodel', providerName: 'Qoder CLI', inputTokens: 9_000, outputTokens: 191 },
      { modelProviderId: 'gemini-oauth::gemini-3.1-flash-lite', model: 'gemini-3.1-flash-lite', providerName: 'Gemini OAuth', inputTokens: 19_000, outputTokens: 762 },
    ],
  });

  assert.equal(snapshot.notes.scope, 'request_snapshot');
  assert.equal(snapshot.byProvider.length, 2, '两个渠道各一行');
  const qoder = snapshot.byProvider.find((row) => row.key === 'qoder-cli');
  assert.ok(qoder, 'Qoder CLI 收敛为单行');
  assert.equal(qoder.inputTokens, 205_009_000);
  assert.equal(qoder.requestCount, 2);
  const gemini = snapshot.byProvider.find((row) => row.key === 'gemini-oauth');
  assert.ok(gemini, 'Gemini OAuth 复合 id 仍归到渠道');
});

test('aggregateRequestUsage labels models via provider index modelLabel (方案 A label)', () => {
  const providers = [
    { id: 'uuid-cmodel', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'cmodel', modelLabel: 'Cantus' },
    { id: 'uuid-kmodel', groupId: 'qoder-cli', name: 'Qoder CLI', model: 'kmodel_latest', modelLabel: 'Kimi-K3' },
  ];
  const requests = [
    { modelProviderId: 'uuid-cmodel', model: 'cmodel', providerName: 'Qoder CLI', inputTokens: 100 },
    { modelProviderId: 'uuid-kmodel', model: 'kmodel_latest', providerName: 'Qoder CLI', inputTokens: 50 },
  ];

  const { byModel } = aggregateRequestUsage(requests, {
    providerIndex: buildProviderIndex(providers),
  });

  const cantus = byModel.get('uuid-cmodel');
  assert.equal(cantus.label, 'Cantus', '显示配置的 modelLabel 而非快照里的模型 id');
  assert.equal(cantus.model, 'Cantus');
  assert.equal(byModel.get('uuid-kmodel').label, 'Kimi-K3');
});

test('aggregateRequestUsage falls back to recorded model id when no label matches', () => {
  // 渠道已删 / 条目无 modelLabel 时，保留快照里的原始 id，不留空 label。
  const requests = [
    { modelProviderId: 'gone-uuid', model: 'cmodel', providerName: 'Qoder CLI', inputTokens: 10 },
  ];
  const { byModel } = aggregateRequestUsage(requests, {
    providerIndex: buildProviderIndex([]),
  });
  assert.equal(byModel.get('gone-uuid').label, 'cmodel');
});
