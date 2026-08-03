import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from './conversation-store.mjs';

/**
 * ADR 23: 会话累计用量(lifetimeUsage)测试。
 * 核心命题:lifetimeUsage 存于 index meta,独立于消息 jsonl,
 * 因此 replaceMessages(压缩)不会清零计费 —— 这是本次修复的本质。
 */
function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-store-test-'));
  const store = createConversationStore({ storeDir: dir });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function accountingSnapshot(input = {}) {
  return {
    version: 1,
    conversationId: 'placeholder',
    contentRevision: 0,
    modelKey: 'provider-1',
    revision: 1,
    phase: 'turn_complete',
    compactionEpoch: 0,
    contextWindow: 500_000,
    inputBudget: 500_000,
    compactionThresholdTokens: 400_000,
    authoritativeInputTokens: 19_500,
    percent: 4,
    pressureSource: 'provider_usage',
    pendingUncountedChanges: false,
    pendingContentChars: 0,
    countCapability: { kind: 'observed_usage_only' },
    counterStatus: 'active',
    updatedAt: 1,
    ...input,
  };
}

test('addUsage accumulates lifetime usage on index meta', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 20 });
    const after = store.addUsage(conv.id, { inputTokens: 5, outputTokens: 3, cacheWriteTokens: 1, cacheReadTokens: 2 });
    assert.deepEqual(after, {
      inputTokens: 105,
      outputTokens: 53,
      cacheWriteTokens: 11,
      cacheReadTokens: 22,
    });
  } finally {
    cleanup();
  }
});

test('recordRuntimeTurnUsage serializes scoped lifetime and runtime-turn ledger writes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-usage-scope-'));
  const storeDir = path.join(dir, 'conversations');
  const usageLogFile = path.join(dir, 'usage', 'requests.jsonl');
  try {
    const store = createConversationStore({ storeDir, usageLogFile });
    const conv = store.createConversation({ title: 'scoped usage' });
    const recorded = store.recordRuntimeTurnUsage(conv.id, {
      usage: {
        usageScope: 'runtime_turn',
        providerRequestCount: 3,
        inputTokens: 120,
        outputTokens: 9,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        totalTokens: 144,
      },
      attribution: {
        id: 'turn-1',
        modelProviderId: 'provider-1',
        model: 'grok-4.5',
      },
    });

    assert.equal(recorded.lifetimeUsage.usageScope, 'conversation_lifetime');
    assert.equal(recorded.lifetimeUsage.runtimeTurnCount, 1);
    assert.equal(recorded.lifetimeUsage.totalTokens, 144);
    assert.deepEqual(JSON.parse(readFileSync(usageLogFile, 'utf8').trim()), {
      id: 'turn-1',
      at: recorded.ledgerRow.at,
      conversationId: conv.id,
      streamId: null,
      groupId: null,
      modelProviderId: 'provider-1',
      model: 'grok-4.5',
      providerName: null,
      usageScope: 'runtime_turn',
      providerRequestCount: 3,
      inputTokens: 120,
      outputTokens: 9,
      cacheReadTokens: 15,
      cacheWriteTokens: 0,
      totalTokens: 144,
      estimatedCostUsd: null,
      pricingSource: null,
    });
    const duplicate = store.recordRuntimeTurnUsage(conv.id, {
      usage: {
        usageScope: 'runtime_turn',
        providerRequestCount: 3,
        inputTokens: 120,
        outputTokens: 9,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        totalTokens: 144,
      },
      attribution: { id: 'turn-1' },
    });
    assert.equal(duplicate.lifetimeUsage.runtimeTurnCount, 1);
    assert.equal(readFileSync(usageLogFile, 'utf8').trim().split('\n').length, 1);
    assert.throws(
      () => store.recordRuntimeTurnUsage(conv.id, {
        usage: { usageScope: 'provider_request', providerRequestCount: 1 },
      }),
      /usageScope=runtime_turn/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context snapshot is shared while revision and model still match', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'shared context' });
    store.updateModelEffort(conv.id, { modelProviderId: 'provider-1', model: 'model-1' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hello' });

    store.updateContextSnapshot(conv.id, accountingSnapshot());

    const loaded = store.getConversation(conv.id);
    assert.equal(loaded.contentRevision, 1);
    assert.deepEqual(loaded.contextSnapshot, accountingSnapshot({
      conversationId: conv.id,
      contentRevision: 1,
      modelKey: 'provider-1::model-1',
    }));
  } finally {
    cleanup();
  }
});

test('context snapshot sidecar survives an older client clearing the index field', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'sidecar context' });
    store.updateModelEffort(conv.id, { modelProviderId: 'provider-1', model: 'model-1' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hello' });
    store.updateContextSnapshot(conv.id, accountingSnapshot());

    const indexFile = path.join(dir, 'index.jsonl');
    const rows = readFileSync(indexFile, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    rows.find((row) => row.id === conv.id).contextSnapshot = null;
    writeFileSync(indexFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    assert.equal(
      store.getConversation(conv.id).contextSnapshot.authoritativeInputTokens,
      19_500,
    );

    store.appendMessage(conv.id, { id: 'm2', role: 'user', content: 'changed' });
    assert.equal(
      store.getConversation(conv.id).contextSnapshot,
      null,
      'content revision still invalidates the sidecar',
    );
  } finally {
    cleanup();
  }
});

test('legacy TUI composite binding migrates to Desktop provider id without invalidating context', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'binding migration' });
    store.updateModelEffort(conv.id, {
      modelProviderId: 'provider-1::model-1',
      model: 'model-1',
    });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hello' });
    store.updateContextSnapshot(conv.id, accountingSnapshot({
      modelKey: 'provider-1::model-1',
    }));

    store.updateModelEffort(conv.id, {
      modelProviderId: 'provider-1',
      model: 'model-1',
    });

    const loaded = store.getConversation(conv.id);
    assert.equal(loaded.modelProviderId, 'provider-1');
    assert.equal(loaded.contextSnapshot.modelKey, 'provider-1::model-1');
    assert.equal(loaded.contextSnapshot.authoritativeInputTokens, 19_500);
  } finally {
    cleanup();
  }
});

test('shared store restores only provider-request observations, never runtime-turn billing rows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-observed-'));
  const usageLogFile = path.join(dir, 'usage', 'requests.jsonl');
  const storeDir = path.join(dir, 'conversations');
  try {
    const store = createConversationStore({ storeDir, usageLogFile });
    const conv = store.createConversation({ title: 'observed fallback' });
    store.updateModelEffort(conv.id, {
      modelProviderId: 'provider-1',
      model: 'grok-4.5',
    });
    store.updateContextSnapshot(conv.id, accountingSnapshot({
      modelKey: 'provider-1::grok-4.5',
      lastObserved: {
        inputTokens: 45_000,
        requestFingerprint: 'request-final',
        compactionEpoch: 0,
        source: 'provider_usage',
        observedAt: 123,
      },
    }));
    // Advancing content invalidates the current snapshot but must retain its
    // last provider-request observation as a pending restore baseline.
    store.appendMessage(conv.id, { id: 'next-user', role: 'user', content: 'continue' });
    mkdirSync(path.dirname(usageLogFile), { recursive: true });
    writeFileSync(usageLogFile, [
      JSON.stringify({
        conversationId: conv.id,
        model: 'grok-4.5',
        usageScope: 'runtime_turn',
        inputTokens: 145_639,
        cacheReadTokens: 0,
      }),
    ].join('\n') + '\n');

    assert.deepEqual(
      store.getLatestContextObservation(conv.id, {
        modelKey: 'provider-1::grok-4.5',
      }),
      {
        inputTokens: 45_000,
        requestFingerprint: 'request-final',
        compactionEpoch: 0,
        source: 'provider_usage',
        observedAt: 123,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message, compaction, and model changes invalidate the shared context snapshot', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'invalidate context' });
    store.updateModelEffort(conv.id, { modelProviderId: 'provider-1', model: 'model-1' });
    store.updateContextSnapshot(conv.id, accountingSnapshot({
      contextWindow: 100,
      inputBudget: 100,
      compactionThresholdTokens: 80,
      authoritativeInputTokens: 10,
      percent: 10,
    }));
    assert.ok(store.getConversation(conv.id).contextSnapshot);

    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'changed' });
    assert.equal(store.getConversation(conv.id).contextSnapshot, null);

    store.updateContextSnapshot(conv.id, accountingSnapshot({
      contextWindow: 100,
      inputBudget: 100,
      compactionThresholdTokens: 80,
      authoritativeInputTokens: 20,
      percent: 20,
    }));
    store.replaceMessages(conv.id, [{ id: 'summary', role: 'system', content: 'compacted' }]);
    assert.equal(store.getConversation(conv.id).contextSnapshot, null);

    store.updateContextSnapshot(conv.id, accountingSnapshot({
      contextWindow: 100,
      inputBudget: 100,
      compactionThresholdTokens: 80,
      authoritativeInputTokens: 5,
      percent: 5,
    }));
    store.updateModelEffort(conv.id, { modelProviderId: 'provider-2', model: 'model-2' });
    assert.equal(store.getConversation(conv.id).contextSnapshot, null);
  } finally {
    cleanup();
  }
});

test('replaceMessages refuses a stale empty overwrite but allows an explicitly requested clear', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'protected' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'must survive' });

    assert.throws(
      () => store.replaceMessages(conv.id, []),
      /Refusing to replace non-empty conversation/,
    );
    assert.deepEqual(store.getConversation(conv.id).messages.map((message) => message.id), ['m1']);

    store.replaceMessages(conv.id, [], { allowEmpty: true });
    assert.deepEqual(store.getConversation(conv.id).messages, []);
  } finally {
    cleanup();
  }
});

test('replaceMessages accepts an empty list for a newly created empty conversation', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'new empty conversation' });
    store.replaceMessages(conv.id, []);
    assert.deepEqual(store.getConversation(conv.id).messages, []);
  } finally {
    cleanup();
  }
});

test('lifetimeUsage survives replaceMessages (compaction does NOT reset billing)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, { id: 'm2', role: 'assistant', content: 'yo' });
    store.addUsage(conv.id, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 300 });

    // 模拟压缩:用一条摘要消息替换全部历史消息。
    store.replaceMessages(conv.id, [{ id: 's1', role: 'system', content: 'summary' }]);

    const reloaded = store.getConversation(conv.id);
    // 消息确实被压缩替换了。
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0].id, 's1');
    // 但计费累计完整保留 —— 这正是修复的目标。
    assert.deepEqual(reloaded.lifetimeUsage, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 300,
    });
  } finally {
    cleanup();
  }
});

/**
 * ADR 33: 每条消息的整轮工作时长(durationMs)随消息持久化。
 * 存储层是开放袋,无字段白名单,故 durationMs 经 append / replaceMessages 原样往返;
 * 这是「重启后仍能看到每轮工作时长」的存储侧证据。
 */
test('durationMs round-trips through append and replaceMessages (ADR 33)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      durationMs: 8421,
    });

    const afterAppend = store.getConversation(conv.id);
    const appendedAssistant = afterAppend.messages.find((m) => m.id === 'a1');
    assert.equal(appendedAssistant.durationMs, 8421);

    // 模拟 renderer 的 replace 投影(如删除其它消息后重写),durationMs 必须保留。
    store.replaceMessages(conv.id, [
      { id: 'a1', role: 'assistant', content: 'done', durationMs: 8421 },
    ]);

    const reloaded = store.getConversation(conv.id);
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0].durationMs, 8421);
  } finally {
    cleanup();
  }
});

test('messages without durationMs load cleanly (ADR 33)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    const reloaded = store.getConversation(conv.id);
    assert.equal(reloaded.messages[0].durationMs, undefined);
  } finally {
    cleanup();
  }
});

test('conversation mode is per-conversation: defaults to chat, persists, and isolates', () => {
  const { store, cleanup } = freshStore();
  try {
    // 默认会话模式为 chat,且写入 index meta(随会话持久化,非全局)。
    const a = store.createConversation({ title: 'a' });
    assert.equal(a.mode, 'chat');
    assert.equal(store.getConversation(a.id).mode, 'chat');

    // 创建时可显式指定 plan 模式。
    const b = store.createConversation({ title: 'b', mode: 'plan' });
    assert.equal(b.mode, 'plan');

    // wire 值迁移后:'goal' 是自驱目标模式的当前合法值,新建时原样保留(不再兼容映射为 plan)。
    const g = store.createConversation({ title: 'g', mode: 'goal' });
    assert.equal(g.mode, 'goal');
    assert.equal(store.getConversation(g.id).mode, 'goal');

    // 改 b 不影响 a —— 模式按会话隔离(本次重构的核心命题)。
    const updated = store.updateMode(b.id, 'chat');
    assert.equal(updated.mode, 'chat');
    assert.equal(store.getConversation(b.id).mode, 'chat');
    assert.equal(store.getConversation(a.id).mode, 'chat');

    // 把 a 切到 plan,b 仍为 chat。
    store.updateMode(a.id, 'plan');
    assert.equal(store.getConversation(a.id).mode, 'plan');
    assert.equal(store.getConversation(b.id).mode, 'chat');
  } finally {
    cleanup();
  }
});

test('one-time migration rewrites pre-existing legacy goal-mode index rows to plan', () => {
  // wire 值迁移(ADR 41):撤销 goal→plan 兼容映射前,存量 index 里历史的 mode='goal'
  // (旧 plan 语义)必须在 store 初始化时被一次性改写为 'plan',否则会被误判为新自驱语义。
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-store-migrate-'));
  try {
    const indexFile = path.join(dir, 'index.jsonl');
    const now = new Date().toISOString();
    // 直接写入原始 index:一条历史 goal(旧 plan 语义)、一条 chat。
    writeFileSync(
      indexFile,
      [
        JSON.stringify({ id: 'legacy-goal', title: 'lg', mode: 'goal', status: 'active', createdAt: now, updatedAt: now }),
        JSON.stringify({ id: 'plain-chat', title: 'pc', mode: 'chat', status: 'active', createdAt: now, updatedAt: now }),
      ].join('\n') + '\n',
      'utf8',
    );

    // 首次初始化触发迁移:历史 goal → plan。
    const store = createConversationStore({ storeDir: dir });
    assert.equal(store.getConversation('legacy-goal').mode, 'plan');
    assert.equal(store.getConversation('plain-chat').mode, 'chat');

    // 迁移后新建的自驱 goal 会话不受影响(marker 已写,不再回写)。
    const fresh = store.createConversation({ title: 'fresh-goal', mode: 'goal' });
    assert.equal(fresh.mode, 'goal');
    const store2 = createConversationStore({ storeDir: dir });
    assert.equal(store2.getConversation(fresh.id).mode, 'goal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateMode normalizes unknown values to chat and returns null on missing conversation', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't', mode: 'nonsense' });
    // 未知模式入库时归一为 chat。
    assert.equal(conv.mode, 'chat');
    const updated = store.updateMode(conv.id, 'also-bogus');
    assert.equal(updated.mode, 'chat');
    assert.equal(store.updateMode('does-not-exist', 'goal'), null);
  } finally {
    cleanup();
  }
});

test('effort + modelProviderId are per-conversation: default, persist, isolate, and normalize', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    // 新会话默认 effort='default'、modelProviderId=null（未绑定，用全局默认 provider）。
    const a = store.createConversation({ title: 'a' });
    assert.equal(a.effort, 'default');
    assert.equal(a.modelProviderId, null);
    assert.equal(store.getConversation(a.id).effort, 'default');
    assert.equal(store.getConversation(a.id).modelProviderId, null);

    const b = store.createConversation({ title: 'b' });

    // 只切 effort 不影响 modelProviderId。
    const afterEffort = store.updateModelEffort(a.id, { effort: 'high' });
    assert.equal(afterEffort.effort, 'high');
    assert.equal(afterEffort.modelProviderId, null);

    // GPT-5.6 等模型的原生 max 档可作为会话真值持久化。
    const afterMaxEffort = store.updateModelEffort(a.id, { effort: 'max' });
    assert.equal(afterMaxEffort.effort, 'max');

    // 只切模型不影响 effort（两者各自独立）。
    const afterModel = store.updateModelEffort(a.id, { modelProviderId: 'grp1::gpt-x' });
    assert.equal(afterModel.effort, 'max');
    assert.equal(afterModel.modelProviderId, 'grp1::gpt-x');

    // 会话隔离：改 a 不影响 b。
    assert.equal(store.getConversation(b.id).effort, 'default');
    assert.equal(store.getConversation(b.id).modelProviderId, null);

    // 非法 effort 归一为 default；空白 modelProviderId 归一为 null。
    const normalized = store.updateModelEffort(a.id, { effort: 'bogus', modelProviderId: '   ' });
    assert.equal(normalized.effort, 'default');
    assert.equal(normalized.modelProviderId, null);

    // 缺省会话返回 null。
    assert.equal(store.updateModelEffort('nope', { effort: 'high' }), null);

    // 跨重启（重建 store 读同目录）后绑定值保留。
    store.updateModelEffort(a.id, { effort: 'low', modelProviderId: 'grp2::claude-y' });
    const store2 = createConversationStore({ storeDir: dir });
    assert.equal(store2.getConversation(a.id).effort, 'low');
    assert.equal(store2.getConversation(a.id).modelProviderId, 'grp2::claude-y');

    // 发送成功后可同时落盘实际 model 快照；跨重启保留。
    const afterModelName = store2.updateModelEffort(a.id, {
      modelProviderId: 'grp2::claude-y',
      model: 'claude-y',
    });
    assert.equal(afterModelName.modelProviderId, 'grp2::claude-y');
    assert.equal(afterModelName.model, 'claude-y');
    const store3 = createConversationStore({ storeDir: dir });
    assert.equal(store3.getConversation(a.id).model, 'claude-y');
    assert.equal(store3.getConversation(a.id).modelProviderId, 'grp2::claude-y');

    // 空串/空白 model 归一为 null。
    const cleared = store3.updateModelEffort(a.id, { model: '   ' });
    assert.equal(cleared.model, null);
  } finally {
    cleanup();
  }
});

test('legacy conversations without effort/modelProviderId load with safe fallbacks', () => {
  // 老会话（index 无 effort/modelProviderId 字段）读取时应回退 default/null，不抛错。
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-store-legacy-me-'));
  try {
    const indexFile = path.join(dir, 'index.jsonl');
    const now = new Date().toISOString();
    writeFileSync(
      indexFile,
      JSON.stringify({ id: 'legacy', title: 'lg', mode: 'chat', status: 'active', createdAt: now, updatedAt: now }) + '\n',
      'utf8',
    );
    const store = createConversationStore({ storeDir: dir });
    const conv = store.getConversation('legacy');
    assert.equal(conv.effort, 'default');
    assert.equal(conv.modelProviderId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addUsage on missing conversation returns null', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.addUsage('does-not-exist', { inputTokens: 1 }), null);
  } finally {
    cleanup();
  }
});

test('addUsage tolerates partial / missing usage fields', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    const after = store.addUsage(conv.id, { inputTokens: 7 });
    assert.deepEqual(after, {
      inputTokens: 7,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  } finally {
    cleanup();
  }
});

/**
 * 列表排序：应按「最近修改」(updatedAt) 降序，而非创建时间 (createdAt)。
 * 直接写 index.jsonl 注入确定性时间戳，避免依赖真实时钟（同毫秒会导致排序 flaky）。
 */
test('listConversations sorts by updatedAt desc, not createdAt', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    // 故意让 createdAt 顺序与 updatedAt 顺序相反：
    //   old 创建最早，但最近被修改 -> 应排在最前
    //   new 创建最晚，但很久没动 -> 应排在最后
    const rows = [
      { id: 'old', title: 'old', mode: 'chat', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-06-01T00:00:00.000Z' },
      { id: 'mid', title: 'mid', mode: 'chat', createdAt: '2024-02-01T00:00:00.000Z', updatedAt: '2024-05-01T00:00:00.000Z' },
      { id: 'new', title: 'new', mode: 'chat', createdAt: '2024-03-01T00:00:00.000Z', updatedAt: '2024-04-01T00:00:00.000Z' },
    ];
    writeFileSync(path.join(dir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const list = store.listConversations();
    assert.deepEqual(list.map((c) => c.id), ['old', 'mid', 'new']);
  } finally {
    cleanup();
  }
});

test('listConversations falls back to createdAt when updatedAt missing', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const rows = [
      { id: 'a', title: 'a', mode: 'chat', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'b', title: 'b', mode: 'chat', createdAt: '2024-03-01T00:00:00.000Z' },
      { id: 'c', title: 'c', mode: 'chat', createdAt: '2024-02-01T00:00:00.000Z' },
    ];
    writeFileSync(path.join(dir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const list = store.listConversations();
    assert.deepEqual(list.map((c) => c.id), ['b', 'c', 'a']);
  } finally {
    cleanup();
  }
});

test('conversation archive status filters active and archived lists', () => {
  const { store, cleanup } = freshStore();
  try {
    const active = store.createConversation({ title: 'active' });
    const archived = store.createConversation({ title: 'archived' });

    const archivedMeta = store.archiveConversation(archived.id);
    assert.equal(archivedMeta.status, 'archived');
    assert.ok(archivedMeta.archivedAt);

    assert.deepEqual(store.listConversations({ status: 'active' }).map((c) => c.id), [active.id]);
    assert.deepEqual(store.listConversations({ status: 'archived' }).map((c) => c.id), [archived.id]);

    const restored = store.restoreConversation(archived.id);
    assert.equal(restored.status, 'active');
    assert.equal(restored.archivedAt, null);
    assert.deepEqual(new Set(store.listConversations({ status: 'active' }).map((c) => c.id)), new Set([active.id, archived.id]));
  } finally {
    cleanup();
  }
});

test('legacy conversations without status are treated as active', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const rows = [
      { id: 'legacy', title: 'legacy', mode: 'chat', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'archived', title: 'archived', mode: 'chat', status: 'archived', archivedAt: '2024-02-01T00:00:00.000Z', createdAt: '2024-02-01T00:00:00.000Z', updatedAt: '2024-02-01T00:00:00.000Z' },
    ];
    writeFileSync(path.join(dir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    assert.deepEqual(store.listConversations({ status: 'active' }).map((c) => c.id), ['legacy']);
    assert.deepEqual(store.listConversations({ status: 'archived' }).map((c) => c.id), ['archived']);
  } finally {
    cleanup();
  }
});

test('autoArchiveConversations archives old active conversations and skips excluded/running ids', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const rows = [
      { id: 'old', title: 'old', mode: 'chat', status: 'active', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'excluded', title: 'excluded', mode: 'chat', status: 'active', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
      { id: 'fresh', title: 'fresh', mode: 'chat', status: 'active', createdAt: '2024-03-01T00:00:00.000Z', updatedAt: '2024-03-01T00:00:00.000Z' },
      { id: 'already', title: 'already', mode: 'chat', status: 'archived', archivedAt: '2024-01-03T00:00:00.000Z', createdAt: '2024-01-03T00:00:00.000Z', updatedAt: '2024-01-03T00:00:00.000Z' },
    ];
    writeFileSync(path.join(dir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const result = store.autoArchiveConversations({ before: '2024-02-01T00:00:00.000Z', excludeIds: ['excluded'] });
    assert.deepEqual(result, { archivedIds: ['old'], archivedCount: 1 });
    assert.deepEqual(new Set(store.listConversations({ status: 'active' }).map((c) => c.id)), new Set(['excluded', 'fresh']));
    assert.deepEqual(new Set(store.listConversations({ status: 'archived' }).map((c) => c.id)), new Set(['old', 'already']));
  } finally {
    cleanup();
  }
});

/**
 * 方案 3: updateMessageById 是「助手正文持久化真值下沉主进程」的落盘原语。
 * 验证: 按 id 精确 patch、未命中回退最后一条 assistant、无目标返回 null、浅合并保字段。
 */
test('updateMessageById patches the message by id (shallow merge)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, { id: 'a1', role: 'assistant', content: '', timestamp: 111 });
    const res = store.updateMessageById(conv.id, 'a1', {
      content: 'hello world',
      segments: [{ type: 'text', content: 'hello world' }],
    });
    const a1 = res.messages.find((m) => m.id === 'a1');
    assert.equal(a1.content, 'hello world');
    assert.deepEqual(a1.segments, [{ type: 'text', content: 'hello world' }]);
    // 浅合并: 未在 patch 中的字段保留。
    assert.equal(a1.timestamp, 111);
    // 重新读取持久化结果，确认确实落盘。
    const reloaded = store.getConversation(conv.id).messages.find((m) => m.id === 'a1');
    assert.equal(reloaded.content, 'hello world');
  } finally {
    cleanup();
  }
});

test('updateMessageById marks interrupted on terminal error patch', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'a1', role: 'assistant', content: '' });
    store.updateMessageById(conv.id, 'a1', { content: 'partial', interrupted: true });
    const a1 = store.getConversation(conv.id).messages.find((m) => m.id === 'a1');
    assert.equal(a1.interrupted, true);
    assert.equal(a1.content, 'partial');
  } finally {
    cleanup();
  }
});

test('updateMessageById falls back to last assistant when id not found (regenerate path)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, { id: 'old-assistant', role: 'assistant', content: '' });
    // renderer regenerate 用了新 id，但 store 仍是旧的 last-message id。
    const res = store.updateMessageById(conv.id, 'brand-new-id', { content: 'regenerated' });
    const last = res.messages[res.messages.length - 1];
    assert.equal(last.id, 'old-assistant');
    assert.equal(last.content, 'regenerated');
  } finally {
    cleanup();
  }
});

test('updateMessageById returns null when there is no target message', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    // 只有 user 消息，无 assistant，且 id 不命中 → 不静默新建。
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    const res = store.updateMessageById(conv.id, 'nope', { content: 'x' });
    assert.equal(res, null);
    // 空会话同样返回 null。
    const conv2 = store.createConversation({ title: 't2' });
    assert.equal(store.updateMessageById(conv2.id, 'a', { content: 'x' }), null);
  } finally {
    cleanup();
  }
});

test('pinConversation persists pinned metadata and unpinConversation clears it', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'pin me' });
    const pinned = store.pinConversation(conv.id);
    assert.equal(typeof pinned.pinnedAt, 'string');
    assert.equal(pinned.pinnedOrder, 0);

    const reloaded = store.listConversations({ status: 'active' }).find((item) => item.id === conv.id);
    assert.equal(reloaded.pinnedAt, pinned.pinnedAt);
    assert.equal(reloaded.pinnedOrder, 0);

    const unpinned = store.unpinConversation(conv.id);
    assert.equal(unpinned.pinnedAt, null);
    assert.equal(unpinned.pinnedOrder, null);
  } finally {
    cleanup();
  }
});

test('reorderPinnedConversations updates only active pinned conversations order', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.createConversation({ title: 'a' });
    const b = store.createConversation({ title: 'b' });
    const c = store.createConversation({ title: 'c' });
    store.pinConversation(a.id);
    store.pinConversation(b.id);
    store.pinConversation(c.id);

    store.reorderPinnedConversations([a.id, c.id, b.id]);
    const pinned = store.listConversations({ status: 'active' })
      .filter((conv) => conv.pinnedAt)
      .sort((left, right) => left.pinnedOrder - right.pinnedOrder);
    assert.deepEqual(pinned.map((conv) => conv.id), [a.id, c.id, b.id]);
    assert.deepEqual(pinned.map((conv) => conv.pinnedOrder), [0, 1, 2]);
  } finally {
    cleanup();
  }
});

test('archiving a pinned conversation clears pinned metadata', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'pinned' });
    store.pinConversation(conv.id);
    const archived = store.archiveConversation(conv.id);
    assert.equal(archived.status, 'archived');
    assert.equal(archived.pinnedAt, null);
    assert.equal(archived.pinnedOrder, null);

    const reloaded = store.listConversations({ status: 'archived' }).find((item) => item.id === conv.id);
    assert.equal(reloaded.pinnedAt, null);
    assert.equal(reloaded.pinnedOrder, null);
  } finally {
    cleanup();
  }
});

test('multiple store instances preserve conversations created by each process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-concurrent-'));
  try {
    const desktopStore = createConversationStore({ storeDir: dir });
    const tuiStore = createConversationStore({ storeDir: dir });
    const desktop = desktopStore.createConversation({ title: 'desktop' });
    const tui = tuiStore.createConversation({ title: 'tui', mode: 'goal' });

    const reloaded = createConversationStore({ storeDir: dir }).listConversations();
    assert.deepEqual(new Set(reloaded.map((item) => item.id)), new Set([desktop.id, tui.id]));
    assert.equal(reloaded.find((item) => item.id === tui.id)?.mode, 'goal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store change subscription observes writes from another store instance', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-events-'));
  try {
    const desktopStore = createConversationStore({ storeDir: dir });
    const tuiStore = createConversationStore({ storeDir: dir });
    const eventPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('conversation change event timed out')), 2_000);
      const unsubscribe = desktopStore.subscribeChanges((event) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      }, { interval: 20 });
    });
    const conversation = tuiStore.createConversation({ title: 'from tui', workspacePath: '/workspace' });
    const event = await eventPromise;
    assert.equal(event.conversationId, conversation.id);
    assert.equal(event.workspacePath, '/workspace');
    assert.equal(event.changeType, 'created');
    assert.equal(typeof event.revision, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI continuation invalidates Desktop context and publishes one shared replacement snapshot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-context-'));
  try {
    const desktopStore = createConversationStore({ storeDir: dir });
    const tuiStore = createConversationStore({ storeDir: dir });
    const conversation = desktopStore.createConversation({ title: 'cross-client context' });
    desktopStore.updateModelEffort(conversation.id, {
      modelProviderId: 'provider-1::model-1',
      model: 'model-1',
    });
    desktopStore.appendMessage(conversation.id, { id: 'desktop-user', role: 'user', content: 'start' });
    desktopStore.updateContextSnapshot(conversation.id, accountingSnapshot({
      modelKey: 'provider-1::model-1',
      authoritativeInputTokens: 195_000,
      percent: 39,
    }));
    assert.equal(
      tuiStore.getConversation(conversation.id).contextSnapshot.authoritativeInputTokens,
      195_000,
    );

    tuiStore.appendMessage(conversation.id, { id: 'tui-user', role: 'user', content: 'continue' });
    assert.equal(desktopStore.getConversation(conversation.id).contextSnapshot, null);

    tuiStore.appendMessage(conversation.id, { id: 'tui-assistant', role: 'assistant', content: 'continued' });
    tuiStore.updateContextSnapshot(conversation.id, accountingSnapshot({
      modelKey: 'provider-1::model-1',
      authoritativeInputTokens: 42_500,
      percent: 9,
    }));

    const shared = desktopStore.getConversation(conversation.id);
    assert.equal(shared.contextSnapshot.authoritativeInputTokens, 42_500);
    assert.equal(shared.contextSnapshot.contextWindow, 500_000);
    assert.equal(shared.contextSnapshot.contentRevision, shared.contentRevision);
    assert.equal(shared.contextSnapshot.modelKey, 'provider-1::model-1');
    assert.equal(shared.contextSnapshot.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple store instances append messages without overwriting each other', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-messages-'));
  try {
    const desktopStore = createConversationStore({ storeDir: dir });
    const tuiStore = createConversationStore({ storeDir: dir });
    const conversation = desktopStore.createConversation({ title: '' });

    desktopStore.appendMessage(conversation.id, { id: 'desktop', role: 'user', content: 'from desktop' });
    tuiStore.appendMessage(conversation.id, { id: 'tui', role: 'assistant', content: 'from tui' });

    const reloaded = createConversationStore({ storeDir: dir }).getConversation(conversation.id);
    assert.deepEqual(reloaded.messages.map((message) => message.id), ['desktop', 'tui']);
    assert.equal(reloaded.title, 'from desktop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchConversations ranks title matches and excludes archived by default', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-search-'));
  try {
    const store = createConversationStore({ storeDir: dir });
    const exact = store.createConversation({ title: 'Search Chats', workspacePath: '/ws/a' });
    const prefix = store.createConversation({ title: 'Search chats palette', workspacePath: '/ws/b' });
    const contains = store.createConversation({ title: 'Implement search chats', workspacePath: '/ws/c' });
    const other = store.createConversation({ title: 'Unrelated task', workspacePath: '/ws/a' });
    const archived = store.createConversation({ title: 'Search archived', workspacePath: '/ws/a' });
    store.archiveConversation(archived.id);

    // Make recency deterministic among equal-score items.
    store.updateTitle(contains.id, 'Implement search chats');
    store.updateTitle(prefix.id, 'Search chats palette');
    store.updateTitle(exact.id, 'Search Chats');

    const results = store.searchConversations({ query: 'search chats' });
    assert.deepEqual(results.map((item) => item.id), [exact.id, prefix.id, contains.id]);
    assert.equal(results.some((item) => item.id === other.id), false);
    assert.equal(results.some((item) => item.id === archived.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchConversations empty query returns recent active conversations with limit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conversations-search-empty-'));
  try {
    const store = createConversationStore({ storeDir: dir });
    const older = store.createConversation({ title: 'Older', workspacePath: '/ws/a' });
    const newer = store.createConversation({ title: 'Newer', workspacePath: '/ws/b' });
    const archived = store.createConversation({ title: 'Archived recent', workspacePath: '/ws/c' });
    store.archiveConversation(archived.id);
    store.updateTitle(newer.id, 'Newer');

    const results = store.searchConversations({ query: '  ', limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, newer.id);
    assert.equal(results[0].id === older.id, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rankConversationMatch prefers exact and prefix title matches', async () => {
  const { rankConversationMatch } = await import('@peer-agent/conversation-store');
  assert.equal(rankConversationMatch({ title: 'Search Chats' }, 'search chats'), 300);
  assert.equal(rankConversationMatch({ title: 'Search chats palette' }, 'search chats'), 200);
  assert.equal(rankConversationMatch({ title: 'Implement search chats' }, 'search chats'), 100);
  assert.equal(rankConversationMatch({ title: 'Other' }, 'search chats'), -1);
  assert.equal(rankConversationMatch({ title: 'Other', workspacePath: '/tmp/search-chats' }, 'search', { includeWorkspaceNameMatch: true }), 50);
});

/**
 * 冷启动优化：messageCount 写入 index 后，listConversations 不应再为计数全量读 jsonl。
 * 污染消息文件后若仍扫全文会得到错误计数；有 index messageCount 时应直接返回 index 值。
 */
test('listConversations prefers index messageCount and skips full jsonl scan', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'count-me', workspacePath: '/ws/count' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hello' });
    store.appendMessage(conv.id, { id: 'm2', role: 'assistant', content: 'world' });

    const listed = store.listConversations();
    assert.equal(listed.find((c) => c.id === conv.id)?.messageCount, 2);

    // 污染消息文件：若 list 再扫全文，messageCount 会变成 0。
    writeFileSync(path.join(dir, `${conv.id}.jsonl`), '{not-json\n');
    const listedAgain = store.listConversations();
    assert.equal(listedAgain.find((c) => c.id === conv.id)?.messageCount, 2);
  } finally {
    cleanup();
  }
});

test('listConversations never reads conversation body on hot path', async () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'legacy', workspacePath: '/ws/legacy' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'a' });
    store.appendMessage(conv.id, { id: 'm2', role: 'assistant', content: 'b' });
    store.appendMessage(conv.id, { id: 'm3', role: 'user', content: 'c' });

    // 模拟老 index：去掉 messageCount 字段
    const indexPath = path.join(dir, 'index.jsonl');
    const rows = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const next = rows.map((row) => {
      if (row.id !== conv.id) return row;
      const { messageCount, ...rest } = row;
      return rest;
    });
    writeFileSync(indexPath, next.map((row) => JSON.stringify(row)).join('\n') + '\n');

    // 污染消息文件：若 list 热路径扫 jsonl 会抛错或返回错误 count。
    writeFileSync(path.join(dir, `${conv.id}.jsonl`), '{not-json\n');

    const listed = createConversationStore({ storeDir: dir }).listConversations();
    // 热路径：缺 count 时返回占位 0，不读正文
    assert.equal(listed.find((c) => c.id === conv.id)?.messageCount, 0);

    // 热路径 list 后 index 仍未同步回填（后台 schedule，不阻塞返回）
    const immediately = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(immediately.find((c) => c.id === conv.id)?.messageCount, undefined);

    // 显式 backfill 才会读正文（恢复合法 jsonl 后）
    writeFileSync(
      path.join(dir, `${conv.id}.jsonl`),
      [
        JSON.stringify({ id: 'm1', role: 'user', content: 'a' }),
        JSON.stringify({ id: 'm2', role: 'assistant', content: 'b' }),
        JSON.stringify({ id: 'm3', role: 'user', content: 'c' }),
      ].join('\n') + '\n',
    );
    const filled = createConversationStore({ storeDir: dir }).listConversations({ backfillMessageCount: true });
    assert.equal(filled.find((c) => c.id === conv.id)?.messageCount, 3);
    const persisted = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(persisted.find((c) => c.id === conv.id)?.messageCount, 3);
  } finally {
    cleanup();
  }
});

test('listConversations reports no next page when the result is below the page limit', () => {
  const { store, cleanup } = freshStore();
  try {
    store.createConversation({ title: 'one', workspacePath: '/ws/short' });
    store.createConversation({ title: 'two', workspacePath: '/ws/short' });

    const page = store.listConversationsByWorkspace('/ws/short', {
      status: 'active',
      limit: 40,
      paginated: true,
    });

    assert.equal(page.items.length, 2);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
  } finally {
    cleanup();
  }
});

test('listConversations supports limit/cursor pagination', () => {
  const { store, cleanup } = freshStore();
  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const conv = store.createConversation({ title: `c${i}`, workspacePath: '/ws/p' });
      ids.push(conv.id);
      // 保证 updatedAt 顺序可预期
      store.updateTitle(conv.id, `c${i}`);
    }
    const page1 = store.listConversations({ status: 'active', limit: 2, paginated: true });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor);
    assert.equal(page1.total, 5);

    const page2 = store.listConversations({
      status: 'active',
      limit: 2,
      cursor: page1.nextCursor,
      paginated: true,
    });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.hasMore, true);

    const page3 = store.listConversations({
      status: 'active',
      limit: 2,
      cursor: page2.nextCursor,
      paginated: true,
    });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.nextCursor, null);

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
    assert.equal(new Set(allIds).size, 5);
  } finally {
    cleanup();
  }
});

test('listConversationsByWorkspace filters by meta before counting', () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.createConversation({ title: 'A', workspacePath: '/ws/a' });
    const b = store.createConversation({ title: 'B', workspacePath: '/ws/b' });
    store.appendMessage(a.id, { id: 'm1', role: 'user', content: 'a1' });
    store.appendMessage(b.id, { id: 'm1', role: 'user', content: 'b1' });
    store.appendMessage(b.id, { id: 'm2', role: 'assistant', content: 'b2' });

    const onlyA = store.listConversationsByWorkspace('/ws/a');
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].id, a.id);
    assert.equal(onlyA[0].messageCount, 1);

    const onlyB = store.listConversationsByWorkspace('/ws/b');
    assert.equal(onlyB.length, 1);
    assert.equal(onlyB[0].messageCount, 2);
  } finally {
    cleanup();
  }
});

test('listConversations can skip messageCount for workspace discovery', () => {
  const { store, dir, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 'skip', workspacePath: '/ws/skip' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'x' });

    // 模拟老 index 无 messageCount + 污染消息文件：skip 路径不得扫 jsonl 回填。
    const indexPath = path.join(dir, 'index.jsonl');
    const rows = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    writeFileSync(
      indexPath,
      rows.map((row) => {
        if (row.id !== conv.id) return JSON.stringify(row);
        const { messageCount, ...rest } = row;
        return JSON.stringify(rest);
      }).join('\n') + '\n',
    );
    writeFileSync(path.join(dir, `${conv.id}.jsonl`), '{not-json\n');

    const listed = createConversationStore({ storeDir: dir }).listConversations({ includeMessageCount: false });
    const row = listed.find((c) => c.id === conv.id);
    assert.ok(row);
    assert.equal(row.messageCount, undefined);

    // index 也不应被回填
    const persisted = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(persisted.find((c) => c.id === conv.id)?.messageCount, undefined);
  } finally {
    cleanup();
  }
});
