import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTokenBuckets,
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

  const gpt55 = snapshot.byModel.find((row) => row.key === `${groupId}::gpt-5.5`);
  assert.ok(gpt55);
  assert.equal(gpt55.label, 'GPT-5.5');
  assert.equal(gpt55.providerName, 'ChatGPT 订阅');
  assert.ok(Math.abs(gpt55.estimatedCostUsd - 3) < 1e-9);

  const byEntry = snapshot.byModel.find((row) => row.key === modelEntryId);
  assert.ok(byEntry);
  assert.equal(byEntry.label, 'GPT-5.5');
  assert.ok(Math.abs(byEntry.estimatedCostUsd - 4) < 1e-9);

  const byGroup = snapshot.byModel.find((row) => row.key === groupId);
  assert.ok(byGroup);
  assert.equal(byGroup.label, 'GPT-5.6 Sol');
  assert.equal(byGroup.providerName, 'ChatGPT 订阅');

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
