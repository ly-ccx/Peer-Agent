import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import { createConversationStore } from './index.mjs';

/**
 * 方案 B：会话账本 lifetimeUsage 增加按模型拆分的 byModel 累计。
 *
 * 验证：同一会话先后用不同 Provider（GPT → DeepSeek）记录运行时用量时，
 * lifetimeUsage.byModel 按 modelProviderId 各自累计 token / 成本 / 请求数，
 * 历史累计不再串账（切模型后不把之前的 token 记到新模型头上）。
 */
describe('lifetimeUsage byModel split (切换 Provider 不串账)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-ledger-bymodel-'));
  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeStore() {
    return createConversationStore({ storeDir: dir });
  }

  function runtimeTurn(overrides = {}) {
    return {
      usageScope: 'runtime_turn',
      providerRequestCount: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      totalTokens: 1700,
      ...overrides,
    };
  }

  it('two providers accumulate into separate byModel keys with their own cost', () => {
    const store = makeStore();
    const conversation = store.createConversation({ title: 'byModel test' });

    // GPT 订阅 两轮
    store.recordRuntimeTurnUsage(conversation.id, {
      usage: runtimeTurn({ inputTokens: 1000, outputTokens: 500 }),
      attribution: {
        modelProviderId: 'gpt-sub::gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        providerName: 'ChatGPT 订阅',
        estimatedCostUsd: 0.05,
      },
    });
    store.recordRuntimeTurnUsage(conversation.id, {
      usage: runtimeTurn({ inputTokens: 2000, outputTokens: 300 }),
      attribution: {
        modelProviderId: 'gpt-sub::gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        providerName: 'ChatGPT 订阅',
        estimatedCostUsd: 0.08,
      },
    });

    // 切到 DeepSeek 一轮
    store.recordRuntimeTurnUsage(conversation.id, {
      usage: runtimeTurn({ inputTokens: 300, outputTokens: 150 }),
      attribution: {
        modelProviderId: 'deepseek::deepseek-v4',
        model: 'deepseek-v4',
        providerName: 'DeepSeek',
        estimatedCostUsd: 0.002,
      },
    });

    const meta = store.getConversation(conversation.id);
    const { lifetimeUsage } = meta;
    assert.ok(lifetimeUsage, 'lifetimeUsage exists');
    assert.ok(lifetimeUsage.byModel, 'byModel exists after runtime turns');

    const gpt = lifetimeUsage.byModel['gpt-sub::gpt-5.6-sol'];
    const deepseek = lifetimeUsage.byModel['deepseek::deepseek-v4'];

    assert.ok(gpt, 'gpt key present');
    assert.equal(gpt.requestCount, 2);
    assert.equal(gpt.inputTokens, 3000);
    assert.equal(gpt.outputTokens, 800);
    assert.equal(gpt.estimatedCostUsd, 0.13);

    assert.ok(deepseek, 'deepseek key present');
    assert.equal(deepseek.requestCount, 1);
    assert.equal(deepseek.inputTokens, 300);
    assert.equal(deepseek.outputTokens, 150);
    assert.equal(deepseek.estimatedCostUsd, 0.002);

    // 顶层 lifetimeUsage 仍是总加总（兼容旧消费方）；runtimeTurnCount 在 meta 顶层。
    assert.equal(lifetimeUsage.inputTokens, 3300);
    assert.equal(lifetimeUsage.outputTokens, 950);
    assert.equal(meta.runtimeTurnCount, 3);
  });

  it('attribution with no modelProviderId falls back to unknown bucket', () => {
    const store = makeStore();
    const conversation = store.createConversation({ title: 'unknown bucket' });

    store.recordRuntimeTurnUsage(conversation.id, {
      usage: runtimeTurn({ inputTokens: 10, outputTokens: 5 }),
      attribution: { model: 'legacy-model' },
    });

    const { lifetimeUsage } = store.getConversation(conversation.id);
    assert.ok(lifetimeUsage.byModel.unknown, 'unknown key present');
    assert.equal(lifetimeUsage.byModel.unknown.inputTokens, 10);
    assert.equal(lifetimeUsage.byModel.unknown.requestCount, 1);
  });
});
