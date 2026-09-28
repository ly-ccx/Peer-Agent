import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectConversationSearchDocuments,
  createConversationSearchIndex,
} from './conversation-search-index.mjs';

const bot = {
  workspaceId: 'ws-1',
  profile: { displayName: '发布机器人' },
  preview: '昨天的说明',
  lastActiveAt: '2026-09-28T03:00:00.000Z',
};

function message(id, text, extra = {}) {
  return {
    workspaceId: 'ws-1',
    message: { id, role: 'user', kind: 'user_input', content: text, createdAt: '2026-09-28T02:00:00.000Z', ...extra },
  };
}

test('collects bots, visible messages, tasks, and active memory', () => {
  const docs = collectConversationSearchDocuments({
    bots: [bot],
    messages: [
      message('m1', '登录已经修好'),
      message('m2', '工具原文', { kind: 'tool_result', role: 'tool' }),
      { workspaceId: 'ws-1', message: { id: 'm3', role: 'tool', kind: 'tool_result', content: 'raw tool' } },
    ],
    tasks: [{ workspaceId: 'ws-1', sessionId: 's1', title: '修复登录', updatedAt: '2026-09-28T01:00:00.000Z' }],
    memories: [
      { id: 'mem-1', workspaceId: 'ws-1', status: 'active', text: '用户偏好深色', createdAt: '2026-09-27T00:00:00.000Z' },
      { id: 'mem-2', status: 'forgotten', text: '忘掉的' },
    ],
  });
  assert.deepEqual(docs.map((doc) => doc.kind), ['bot', 'message', 'task', 'memory']);
  assert.equal(docs[1].messageId, 'm1');
  assert.equal(docs[3].memoryId, 'mem-1');
});

test('incremental updates match a rebuild from the same documents', () => {
  const first = {
    id: 'message:ws-1:m1',
    kind: 'message',
    workspaceId: 'ws-1',
    title: '登录',
    text: '登录已经修好',
    messageId: 'm1',
    updatedAt: '2026-09-28T02:00:00.000Z',
  };
  const second = {
    id: 'task:ws-1:s1',
    kind: 'task',
    workspaceId: 'ws-1',
    title: '修复登录',
    text: '修复登录',
    sessionId: 's1',
    updatedAt: '2026-09-28T03:00:00.000Z',
  };
  const revised = { ...first, text: '登录说明已更新', title: '登录说明' };
  const index = createConversationSearchIndex();
  index.upsert(first);
  index.upsert(second);
  index.upsert(revised);
  index.remove(second.id);
  const incremental = index.search('登录');
  const rebuilt = createConversationSearchIndex();
  rebuilt.rebuild([revised]);
  assert.deepEqual(incremental, rebuilt.search('登录'));
  index.sync([revised, second]);
  const synced = createConversationSearchIndex();
  synced.rebuild([revised, second]);
  assert.deepEqual(index.search('登录'), synced.search('登录'));
});

test('searches 10000 messages in under 150ms', () => {
  const docs = [];
  for (let index = 0; index < 10000; index += 1) {
    docs.push({
      id: `message:ws:${index}`,
      kind: 'message',
      workspaceId: 'ws',
      title: `note ${index}`,
      text: `body ${index} ${index === 9999 ? 'unique-needle' : 'filler'}`,
      messageId: String(index),
      updatedAt: '2026-09-28T00:00:00.000Z',
    });
  }
  const index = createConversationSearchIndex();
  index.rebuild(docs);
  const start = performance.now();
  const hits = index.search('unique-needle');
  const elapsed = performance.now() - start;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, '9999');
  assert.ok(elapsed < 150, `search took ${elapsed}ms`);
});
