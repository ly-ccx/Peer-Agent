import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createMemoryStore } from '../memory/memory-store.mjs';
import { createProjectRegistry } from '../project-registry.mjs';
import { createBotDirectory } from './bot-directory.mjs';
import { createBotLifecycle } from './bot-lifecycle.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-13-directory-'));
}

function harness(root, directoryOptions = {}) {
  const folder = path.join(root, 'demo-project');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'README.md'), 'hello');
  const registry = createProjectRegistry({ filePath: path.join(root, 'projects', 'registry.json') });
  const entry = registry.ensureForPath(folder);
  const conversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const life = createBotLifecycle({
    rootDir: root,
    registry,
    conversationStore,
    memoryStore: createMemoryStore({ rootDir: root }),
    now: () => new Date('2026-09-27T00:00:00.000Z'),
  });
  const created = life.ensureBot(entry.workspaceId);
  const conversationId = created.profile.agentConversationId;
  conversationStore.appendMessage(conversationId, {
    id: 'user-1',
    role: 'user',
    kind: 'user_input',
    content: '看一下目录',
    createdAt: '2026-09-27T01:00:00.000Z',
  });
  conversationStore.appendMessage(conversationId, {
    id: 'card-1',
    role: 'assistant',
    kind: 'system_card',
    content: '需要确认',
    createdAt: '2026-09-27T02:00:00.000Z',
  });
  conversationStore.appendMessage(conversationId, {
    id: 'reply-1',
    role: 'assistant',
    kind: 'agent_reply',
    content: '项'.repeat(100),
    createdAt: '2026-09-27T03:00:00.000Z',
    question: { prompt: '用哪种方案', answered: false },
  });
  conversationStore.appendMessage(conversationId, {
    id: 'hidden-1',
    role: 'assistant',
    kind: 'tool_result',
    content: '工具原文不进预览',
    createdAt: '2026-09-27T04:00:00.000Z',
  });
  const sessions = [{
    sessionId: 'sess-1',
    status: 'running',
    title: '发布说明',
    updatedAt: '2026-09-27T05:00:00.000Z',
  }];
  const approvals = [{ approvalId: 'ap-1', state: 'open' }, { approvalId: 'ap-2', state: 'denied' }];
  const confirmations = [{ accepted: false }];
  const directory = createBotDirectory({
    rootDir: root,
    registry,
    readMessages: (id) => conversationStore.getPersistedConversationHistory(id)?.messages || [],
    listSessions: () => sessions,
    getSession: (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
    listApprovals: () => approvals,
    listConfirmations: () => confirmations,
    now: () => new Date('2026-09-27T06:00:00.000Z'),
    ...directoryOptions,
  });
  return { entry, directory, conversationId, conversationStore };
}

test('列表项截断最后一条可见消息，并计入批准、提问、确认和进行中', () => {
  const root = tempRoot();
  try {
    const { entry, directory } = harness(root);
    const [item] = directory.list();
    assert.equal(item.workspaceId, entry.workspaceId);
    assert.equal(item.profile.displayName, 'demo-project');
    assert.equal(Array.from(item.preview).length, 80);
    assert.equal(item.preview, '项'.repeat(80));
    assert.equal(item.state.needsYou, 3);
    assert.equal(item.state.running, 1);
    assert.equal(item.state.unread, 1);
    assert.equal(item.lastActiveAt, '2026-09-27T05:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('读游标之后未读清零，对话按 kind 分页', () => {
  const root = tempRoot();
  try {
    const { entry, directory } = harness(root);
    const marked = directory.markRead(entry.workspaceId);
    assert.equal(marked.messageId, 'reply-1');
    const cursor = JSON.parse(readFileSync(
      path.join(root, 'project-runtime', entry.workspaceId, 'read-cursor.json'),
      'utf8',
    ));
    assert.equal(cursor.at, '2026-09-27T03:00:00.000Z');
    assert.equal(directory.list()[0].state.unread, 0);
    const page = directory.readConversation(entry.workspaceId, { kinds: ['agent_reply'], limit: 1 });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].id, 'reply-1');
    assert.equal(page.nextCursor, null);
    const mixed = directory.readConversation(entry.workspaceId, { limit: 2 });
    assert.deepEqual(mixed.messages.map((message) => message.id), ['user-1', 'card-1']);
    assert.equal(mixed.nextCursor, 'card-1');
    const rest = directory.readConversation(entry.workspaceId, { limit: 2, before: 'card-1' });
    assert.deepEqual(rest.messages.map((message) => message.id), ['reply-1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未落盘提示卡只在首页投影，分页游标仍指向持久化消息', () => {
  const root = tempRoot();
  try {
    const pendingCard = { cardId: 'projected-card', resolvedState: 'open' };
    const { entry, directory } = harness(root, {
      readCards: () => [pendingCard, { cardId: 'resolved-card', resolvedState: 'resolved' }],
    });
    const first = directory.readConversation(entry.workspaceId, { limit: 2 });
    assert.deepEqual(first.messages.map((message) => message.id), ['user-1', 'card-1', 'projected-card']);
    assert.deepEqual(first.messages[2].cards, [pendingCard]);
    assert.equal(first.nextCursor, 'card-1');
    const second = directory.readConversation(entry.workspaceId, { limit: 2, before: first.nextCursor });
    assert.deepEqual(second.messages.map((message) => message.id), ['reply-1']);
    assert.equal(second.nextCursor, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('对话读取刷新当前签收状态且不改写历史消息，不采信跨项目状态', () => {
  const root=tempRoot();let status='result_ready';let workspaceId;
  try {
    const {entry,directory,conversationId,conversationStore}=harness(root,{
      getSession:id=>({sessionId:id,workspaceId:id==='sess-1'?workspaceId:'foreign',status}),
    });
    workspaceId=entry.workspaceId;
    conversationStore.appendMessage(conversationId,{id:'report',role:'assistant',kind:'agent_reply',content:'Reviewed',
      sources:['sess-1','foreign'],meta:{sessionStates:[{sessionId:'sess-1',status:'result_ready'}]}});
    assert.deepEqual(directory.readConversation(workspaceId).messages.at(-1).meta.sessionStates,[{sessionId:'sess-1',status:'result_ready'}]);
    status='accepted';
    assert.deepEqual(directory.readConversation(workspaceId).messages.at(-1).meta.sessionStates,[{sessionId:'sess-1',status:'accepted'}]);
    const stored=conversationStore.getPersistedConversationHistory(conversationId).messages.at(-1);
    assert.equal(stored.meta.sessionStates[0].status,'result_ready');
    assert.equal(stored.content,'Reviewed');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('默认对话页保留 agent_turn，列表预览仍不显示它', () => {
  const root = tempRoot();
  try {
    const { entry, directory, conversationId, conversationStore } = harness(root);
    conversationStore.appendMessage(conversationId, {
      id: 'turn-1',
      role: 'assistant',
      kind: 'agent_turn',
      content: '',
      createdAt: '2026-09-27T04:30:00.000Z',
      rounds: [{ text: '', toolCalls: [{ name: 'cancel_session', input: { sessionId: 'sess-1' }, result: { sessionId: 'sess-1' } }] }],
    });
    const page = directory.readConversation(entry.workspaceId, { limit: 10 });
    assert.equal(page.messages.some((message) => message.id === 'turn-1'), true);
    assert.equal(page.messages.some((message) => message.id === 'hidden-1'), false);
    assert.equal(directory.list()[0].preview.includes('cancel_session'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('搜索命中名字、预览和任务标题', () => {
  const root = tempRoot();
  try {
    const { directory } = harness(root);
    assert.equal(directory.search('demo').length, 1);
    assert.equal(directory.search('项项').length, 1);
    assert.equal(directory.search('发布说明').length, 1);
    assert.equal(directory.search('工具原文').length, 0);
    assert.equal(directory.search('没有').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没熟悉过的机器人在第一页给出熟悉提议，翻页不带上它', () => {
  const root = tempRoot();
  try {
    const { entry, directory } = harness(root);
    const page = directory.readConversation(entry.workspaceId, { limit: 10 });
    assert.equal(page.familiarizeOffer.text, '要我先熟悉一下这个项目吗？');
    assert.equal(page.familiarizeOffer.action, '先熟悉一下');
    assert.equal(page.messages.some((message) => message.content === page.familiarizeOffer.text), false);
    const rest = directory.readConversation(entry.workspaceId, { limit: 2, before: 'card-1' });
    assert.equal(rest.familiarizeOffer, undefined);
    assert.deepEqual(rest.messages.map((message) => message.id), ['reply-1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('一个等待中的经典目标让需要你加一，不增加进行中', () => {
  const root = tempRoot();
  try {
    const { directory } = harness(root, {
      listClassicGoals: () => [{
        planId: 'plan-wait',
        waitingUser: true,
        updatedAt: '2026-09-27T07:00:00.000Z',
      }, {
        planId: 'plan-run',
        waitingUser: false,
        updatedAt: '2026-09-27T07:00:00.000Z',
      }],
    });
    const [item] = directory.list();
    assert.equal(item.state.needsYou, 4);
    assert.equal(item.state.running, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
