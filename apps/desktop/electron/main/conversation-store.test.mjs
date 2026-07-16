import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
