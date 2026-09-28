import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationStore } from '../../../../../packages/conversation-store/src/index.mjs';
import { createBotLifecycle } from '../../../../../packages/runtime-node/src/project-agent/bot-lifecycle.mjs';
import { createInputQueue } from '../../../../../packages/runtime-node/src/project-agent/input-queue.mjs';
import { createProjectRegistry } from '../../../../../packages/runtime-node/src/project-registry.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';

const METHODS = [
  ['list', {}],
  ['get', { workspaceId: 'ws-1' }],
  ['create', { kind: 'managed', name: '笔记' }],
  ['updateProfile', { workspaceId: 'ws-1', displayName: '新名字' }],
  ['deleteBot', { workspaceId: 'ws-1' }],
  ['submitInput', { workspaceId: 'ws-1', inputId: 'in-1', text: '你好' }],
  ['readConversation', { workspaceId: 'ws-1' }],
  ['listSessions', { workspaceId: 'ws-1' }],
  ['getSession', { sessionId: 'sess-1' }],
  ['cancelSession', { sessionId: 'sess-1' }],
  ['listApprovals', { workspaceId: 'ws-1' }],
  ['decideApproval', { workspaceId: 'ws-1', approvalId: 'ap-1', decision: 'approve' }],
  ['markRead', { workspaceId: 'ws-1' }],
  ['search', { query: '笔记' }],
  ['listHistory', { workspaceId: 'ws-1' }],
  ['continueHistory', { workspaceId: 'ws-1', conversationId: 'conv-1' }],
  ['startFamiliarize', { workspaceId: 'ws-1' }],
];

function throwing(label) {
  return () => {
    throw new Error(`should not call ${label}`);
  };
}

test('开关关闭时每个通道都拒绝，并且不写文件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b2-13-off-'));
  try {
    const service = createProjectAgentApplicationService({
      enabled: () => false,
      directory: {
        list: throwing('list'),
        get: throwing('get'),
        search: throwing('search'),
        readConversation: throwing('read'),
        markRead: throwing('mark'),
      },
      lifecycle: {
        ensureBot: throwing('ensure'),
        startFamiliarize: throwing('familiarize'),
        regenerateAvatar: throwing('avatar'),
        uploadAvatar: throwing('upload'),
        deleteBot: throwing('delete'),
      },
      profileStore: { read: throwing('read-profile'), save: throwing('save') },
      inputQueue: { submitInput: throwing('submit') },
      sessions: { list: throwing('sessions'), get: throwing('session'), cancel: throwing('cancel') },
      approvals: { list: throwing('approvals'), append: throwing('decide') },
      createManaged: () => {
        writeFileSync(path.join(root, 'created'), 'no');
        return { ok: true };
      },
    });
    for (const [method, payload] of METHODS) {
      const result = await service[method](payload);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'PROJECT_AGENT_DISABLED');
    }
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('100ms 内的多次变化合并成一次，并带上全部 workspaceId', () => {
  const events = [];
  const queued = [];
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    directory: {
      markRead: (workspaceId) => ({ ok: true, workspaceId }),
      search: () => [],
      list: () => [],
    },
    lifecycle: {
      deleteBot: (workspaceId) => ({ ok: true, workspaceId }),
    },
    profileStore: { read: () => ({ status: 'active', displayName: '甲' }), save: (profile) => ({ ok: true, profile }) },
    broadcast: (channel, payload) => { events.push({ channel, payload }); },
    schedule: (fn) => { queued.push(fn); return 1; },
  });
  service.markRead({ workspaceId: 'ws-1' });
  service.deleteBot({ workspaceId: 'ws-2' });
  service.markRead({ workspaceId: 'ws-1' });
  assert.equal(events.length, 0);
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'project-agent:changed');
  assert.deepEqual(events[0].payload.workspaceIds, ['ws-1', 'ws-2']);
});

test('提交输入入队并单独通知对话变化', async () => {
  const events = [];
  const queued = [];
  const submitted = [];
  const woken = [];
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    directory: { list: () => [], search: () => [] },
    inputQueue: {
      submitInput: (input) => {
        submitted.push(input);
        return input;
      },
    },
    wake: (workspaceId) => { woken.push(workspaceId); },
    broadcast: (channel, payload) => { events.push({ channel, payload }); },
    schedule: (fn) => { queued.push(fn); return queued.length; },
  });
  const result = await service.submitInput({ workspaceId: 'ws-9', inputId: 'in-1', text: '你好' });
  assert.equal(result.ok, true);
  assert.equal(submitted[0].surface, 'desktop');
  assert.deepEqual(woken, ['ws-9']);
  assert.equal(events.length, 0);
  for (const fn of queued) fn();
  assert.deepEqual(events.map((event) => event.channel), [
    'project-agent:conversation-changed',
    'project-agent:changed',
  ]);
});

test('对话里的决定和任务现场解决同一个 approvalId，并在 300ms 内通知', async () => {
  const settled = [];
  const events = [];
  const queued = [];
  const approval = {
    approvalId: 'tool-1',
    workspaceId: 'ws-1',
    state: 'open',
    capabilityId: 'local.file.write',
    argsDigest: 'a'.repeat(64),
    sessionId: 'sess-1',
  };
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    approvals: {
      list: () => [approval],
      append: (row) => row,
    },
    settleLive: (current, grant) => { settled.push({ current, grant }); return true; },
    rememberGrant: () => { throw new Error('open approval must not preset a grant'); },
    broadcast: (channel, payload) => { events.push({ channel, payload }); },
    schedule: (fn, ms) => { queued.push({ fn, ms }); return 1; },
    directory: { list: () => [], search: () => [] },
  });
  const once = await service.decideApproval({
    workspaceId: 'ws-1',
    approvalId: 'tool-1',
    decision: 'approve',
    duration: 'once',
  });
  assert.equal(once.ok, true);
  assert.equal(once.approval.state, 'approved');
  assert.equal(settled[0].current.approvalId, 'tool-1');
  assert.equal(settled[0].grant.duration, 'once');
  assert.equal(settled[0].grant.remember, false);
  assert.equal(queued[0].ms <= 300, true);
  queued[0].fn();
  assert.equal(events[0].channel, 'project-agent:changed');
  assert.deepEqual(events[0].payload.workspaceIds, ['ws-1']);

  approval.state = 'open';
  const task = await service.decideApproval({
    workspaceId: 'ws-1',
    approvalId: 'tool-1',
    decision: 'approve',
    duration: 'task',
  });
  assert.equal(task.ok, true);
  assert.equal(settled[1].grant.duration, 'task');
  assert.equal(settled[1].grant.remember, true);
});

test('stale 批准写入一次性授权并恢复任务', async () => {
  const grants = [];
  const resumed = [];
  const approval = {
    approvalId: 'tool-9',
    workspaceId: 'ws-1',
    state: 'stale',
    capabilityId: 'local.shell.exec',
    argsDigest: 'b'.repeat(64),
    sessionId: 'sess-9',
    planId: 'plan-9',
  };
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    approvals: {
      list: () => [approval],
      append: (row) => ({ ...row }),
    },
    settleLive: () => { throw new Error('stale approval has no live request'); },
    rememberGrant: (grant) => { grants.push(grant); },
    sessions: {
      resumeFromApproval: async (current) => { resumed.push(current.approvalId); return { ok: true }; },
    },
    schedule: () => 1,
    directory: { list: () => [], search: () => [] },
  });
  const result = await service.decideApproval({
    workspaceId: 'ws-1',
    approvalId: 'tool-9',
    decision: 'approve',
    duration: 'once',
  });
  assert.equal(result.ok, true);
  assert.equal(result.approval.state, 'approved');
  assert.equal(grants[0].capabilityId, 'local.shell.exec');
  assert.equal(grants[0].argsDigest, 'b'.repeat(64));
  assert.equal(grants[0].sessionId, 'sess-9');
  assert.equal(grants[0].workspaceId, 'ws-1');
  assert.deepEqual(resumed, ['tool-9']);
});

test('代理不在线时提问的回答直接投递并记 user_intervened', async () => {
  const delivered = [];
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    inputQueue: { submitInput: (input) => input },
    agentOnline: () => false,
    sessions: {
      deliverAnswer: (input) => {
        delivered.push(input);
        return { userIntervened: true };
      },
    },
    schedule: () => 1,
    directory: { list: () => [], search: () => [] },
  });
  const result = await service.submitInput({
    workspaceId: 'ws-1',
    inputId: 'in-answer',
    text: '用方案 A',
    answerTo: 'card:question:sess-1:q1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'user_intervened');
  assert.equal(result.input.answerTo, 'card:question:sess-1:q1');
  assert.equal(delivered[0].sessionId, 'sess-1');
  assert.equal(delivered[0].workspaceId, 'ws-1');
  assert.equal(delivered[0].text, '用方案 A');
});

test('回答不能写进另一个项目的任务', async () => {
  const delivered = [];
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    inputQueue: { submitInput: (input) => input },
    agentOnline: () => false,
    sessions: {
      deliverAnswer: (input) => {
        delivered.push(input);
        if (input.sessionId !== 'sess-1' || input.workspaceId !== 'ws-1') {
          return { ok: false, error: 'workspace_mismatch' };
        }
        return { userIntervened: true };
      },
    },
    schedule: () => 1,
    directory: { list: () => [], search: () => [] },
  });
  const result = await service.submitInput({
    workspaceId: 'ws-1',
    inputId: 'in-cross',
    text: '写到别处',
    answerTo: 'card:question:sess-other:q1',
  });
  assert.equal(delivered[0].workspaceId, 'ws-1');
  assert.equal(delivered[0].sessionId, 'sess-other');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
});

test('拒绝计划批准时取消对应任务', async () => {
  const cancelled = [];
  const approval = {
    approvalId: 'plan:sess-3',
    workspaceId: 'ws-1',
    state: 'open',
    capabilityId: 'goal.plan',
    sessionId: 'sess-3',
    planId: 'plan-3',
    argsDigest: 'c'.repeat(64),
  };
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    approvals: {
      list: () => [approval],
      append: (row) => ({ ...row }),
    },
    sessions: {
      cancel: async (input) => {
        cancelled.push(input);
        return { status: 'cancelled' };
      },
    },
    settleLive: () => { throw new Error('plan rejection is not a live tool grant'); },
    schedule: () => 1,
    directory: { list: () => [], search: () => [] },
  });
  const result = await service.decideApproval({
    workspaceId: 'ws-1',
    approvalId: 'plan:sess-3',
    decision: 'reject',
  });
  assert.equal(result.ok, true);
  assert.equal(result.approval.state, 'denied');
  assert.deepEqual(cancelled, [{ sessionId: 'sess-3', reason: 'plan_approval_denied' }]);
});

function fileHashes(dir) {
  const out = new Map();
  const walk = (folder) => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

test('旧会话迁成机器人并继续之后，原文件字节不变，快照带着原话', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-09-history-'));
  try {
    const folder = path.join(root, 'repo');
    mkdirSync(folder);
    const storeDir = path.join(root, 'conversations');
    const registry = createProjectRegistry({ filePath: path.join(root, 'projects', 'registry.json') });
    const entry = registry.ensureForPath(folder);
    const conversationStore = createConversationStore({ storeDir });
    const old = conversationStore.createConversation({ title: '旧对话', workspacePath: folder });
    conversationStore.appendMessage(old.id, { id: 'm1', role: 'user', content: '以前说过的话' });
    const loose = conversationStore.createConversation({ title: '没有工作区' });
    conversationStore.appendMessage(loose.id, { id: 'l1', role: 'user', content: '散的一句' });
    const before = fileHashes(storeDir);
    const indexBefore = readFileSync(path.join(storeDir, 'index.jsonl'));
    const life = createBotLifecycle({
      rootDir: root,
      registry,
      conversationStore,
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    });
    const migrated = life.ensureBots([{ path: folder, name: '演示项目', id: entry.workspaceId }]);
    assert.equal(migrated.ok, true);
    assert.equal(migrated.bots[0].created, true);
    assert.equal(migrated.bots[0].displayName, '演示项目');
    assert.equal(migrated.bots[0].familiarize, null);
    const again = life.ensureBots([{ path: folder, name: '演示项目' }]);
    assert.equal(again.bots[0].created, false);
    assert.equal(again.bots[0].agentConversationId, migrated.bots[0].agentConversationId);
    const queue = createInputQueue({
      rootDir: path.join(root, 'runtime'),
      holdsLease: () => true,
      resolveConversationId: () => migrated.bots[0].agentConversationId,
      hasMessage: (conversationId, messageId) => (
        conversationStore.getPersistedConversationHistory(conversationId)?.messages
          ?.some((message) => message.id === messageId) === true
      ),
      appendMessage: (conversationId, message) => {
        conversationStore.appendMessage(conversationId, message);
      },
    });
    const service = createProjectAgentApplicationService({
      enabled: () => true,
      directory: { get: () => ({ ok: true, path: folder }), list: () => [], search: () => [] },
      lifecycle: life,
      inputQueue: queue,
      conversationStore,
      goalPlanStore: {
        listPlans: () => [{
          planId: 'plan-wait',
          conversationId: old.id,
          title: '旧目标',
          status: 'paused',
          runner: { status: 'waiting_user' },
          targetWorkspacePath: folder,
        }],
      },
      broadcast() {},
      schedule: () => 1,
      now: () => '2026-09-28T00:00:00.000Z',
    });
    const listed = service.listHistory({ workspaceId: entry.workspaceId, workspacePath: folder });
    assert.equal(listed.ok, true);
    assert.equal(listed.history.some((item) => item.id === old.id), true);
    assert.equal(listed.history.some((item) => item.id === migrated.bots[0].agentConversationId), false);
    assert.equal(listed.goals[0].planId, 'plan-wait');
    assert.equal(listed.goals[0].waitingUser, true);
    const unscoped = service.listHistory({ unscoped: true });
    assert.equal(unscoped.history.some((item) => item.id === loose.id), true);
    assert.equal(unscoped.history.some((item) => item.id === old.id), false);
    const inputId = randomUUID();
    const continued = service.continueHistory({
      workspaceId: entry.workspaceId,
      conversationId: old.id,
      inputId,
    });
    assert.equal(continued.ok, true);
    assert.equal(continued.input.historyRef, old.id);
    assert.equal(continued.input.text, '继续：旧对话');
    const snapshot = conversationStore.readInheritedBackground(continued.snapshot.snapshotId);
    assert.equal(snapshot.entries.some((row) => row.text.includes('以前说过的话')), true);
    const rejected = service.continueHistory({
      workspaceId: entry.workspaceId,
      conversationId: migrated.bots[0].agentConversationId,
      inputId: randomUUID(),
    });
    assert.equal(rejected.code, 'NOT_HISTORY');
    const indexAfter = readFileSync(path.join(storeDir, 'index.jsonl'));
    assert.equal(indexAfter.subarray(0, indexBefore.length).equals(indexBefore), true);
    const after = fileHashes(storeDir);
    for (const [file, hash] of before) {
      if (!file.endsWith('.jsonl') || path.basename(file) === 'index.jsonl') continue;
      assert.equal(after.get(file), hash, file);
    }
    queue.consume(entry.workspaceId);
    const agent = conversationStore.getPersistedConversationHistory(migrated.bots[0].agentConversationId);
    assert.equal(agent.messages.some((message) => (
      message.historyRef === old.id && message.historySnapshotId === continued.snapshot.snapshotId
    )), true);
    const oldAfter = conversationStore.getConversation(old.id);
    assert.equal(oldAfter.messages.length, 1);
    assert.equal(oldAfter.messages[0].content, '以前说过的话');
    assert.equal(
      createHash('sha256').update(readFileSync(path.join(storeDir, `${old.id}.jsonl`))).digest('hex'),
      before.get(path.join(storeDir, `${old.id}.jsonl`)),
    );
    assert.equal(
      createHash('sha256').update(readFileSync(path.join(storeDir, `${loose.id}.jsonl`))).digest('hex'),
      before.get(path.join(storeDir, `${loose.id}.jsonl`)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('带工具结果的历史要确认后才入队，原会话文件不变', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-09-partial-'));
  try {
    const folder = path.join(root, 'repo');
    mkdirSync(folder);
    const storeDir = path.join(root, 'conversations');
    const registry = createProjectRegistry({ filePath: path.join(root, 'projects', 'registry.json') });
    const entry = registry.ensureForPath(folder);
    const conversationStore = createConversationStore({ storeDir });
    const old = conversationStore.createConversation({ title: '带工具', workspacePath: folder });
    conversationStore.appendMessage(old.id, { id: 'm1', role: 'user', content: '看一下结果' });
    conversationStore.appendMessage(old.id, { id: 't1', role: 'tool', content: '工具输出' });
    const before = createHash('sha256').update(readFileSync(path.join(storeDir, `${old.id}.jsonl`))).digest('hex');
    const life = createBotLifecycle({
      rootDir: root,
      registry,
      conversationStore,
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    });
    const migrated = life.ensureBots([{ path: folder, name: '演示项目', id: entry.workspaceId }]);
    const queue = createInputQueue({
      rootDir: path.join(root, 'runtime'),
      holdsLease: () => true,
      resolveConversationId: () => migrated.bots[0].agentConversationId,
      hasMessage: (conversationId, messageId) => (
        conversationStore.getPersistedConversationHistory(conversationId)?.messages
          ?.some((message) => message.id === messageId) === true
      ),
      appendMessage: (conversationId, message) => {
        conversationStore.appendMessage(conversationId, message);
      },
    });
    const service = createProjectAgentApplicationService({
      enabled: () => true,
      directory: { get: () => ({ ok: true, path: folder }), list: () => [], search: () => [] },
      lifecycle: life,
      inputQueue: queue,
      conversationStore,
      broadcast() {},
      schedule: () => 1,
      now: () => '2026-09-28T00:00:00.000Z',
    });
    const refused = service.continueHistory({
      workspaceId: entry.workspaceId,
      conversationId: old.id,
      inputId: randomUUID(),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'BACKGROUND_CONFIRMATION_REQUIRED');
    assert.equal(queue.consume(entry.workspaceId).consumed.length, 0);
    const continued = service.continueHistory({
      workspaceId: entry.workspaceId,
      conversationId: old.id,
      inputId: randomUUID(),
      confirmMissing: true,
    });
    assert.equal(continued.ok, true);
    assert.equal(continued.input.historyConfirmed, true);
    assert.equal(continued.input.historyRef, old.id);
    const consumed = queue.consume(entry.workspaceId);
    assert.equal(consumed.consumed[0].historyConfirmed, true);
    const agent = conversationStore.getPersistedConversationHistory(migrated.bots[0].agentConversationId);
    assert.equal(agent.messages.some((message) => message.historyConfirmed === true && message.historyRef === old.id), true);
    const oldAfter = conversationStore.getConversation(old.id);
    assert.equal(oldAfter.messages.length, 2);
    assert.equal(oldAfter.messages[1].content, '工具输出');
    assert.equal(
      createHash('sha256').update(readFileSync(path.join(storeDir, `${old.id}.jsonl`))).digest('hex'),
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('搜索返回语料命中，关闭时不读语料', () => {
  let reads = 0;
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    directory: { search: () => [{ workspaceId: 'ws-1', name: '笔记' }] },
    readSearchCorpus: () => {
      reads += 1;
      return {
        bots: [{ workspaceId: 'ws-1', profile: { displayName: '笔记机器人' }, lastActiveAt: '2026-09-28T00:00:00.000Z' }],
        messages: [{
          workspaceId: 'ws-1',
          message: { id: 'm-1', role: 'user', kind: 'user_input', content: '记得买咖啡', createdAt: '2026-09-28T00:00:01.000Z' },
        }],
        tasks: [],
        memories: [],
      };
    },
  });
  const found = service.search({ query: '咖啡' });
  assert.equal(found.ok, true);
  assert.equal(found.items[0].workspaceId, 'ws-1');
  assert.equal(found.hits.some((hit) => hit.kind === 'message' && hit.messageId === 'm-1'), true);
  assert.equal(reads, 1);
  const off = createProjectAgentApplicationService({
    enabled: () => false,
    directory: { search: throwing('search') },
    readSearchCorpus: () => {
      reads += 1;
      return {};
    },
  });
  assert.equal(off.search({ query: '咖啡' }).code, 'PROJECT_AGENT_DISABLED');
  assert.equal(reads, 1);
});

test('同一语料指纹下连续搜索不再重读', () => {
  let reads = 0;
  let stamp = 'v1';
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    directory: { search: () => [] },
    corpusStamp: () => stamp,
    readSearchCorpus: () => {
      reads += 1;
      return {
        bots: [],
        messages: [{
          workspaceId: 'ws-1',
          message: { id: 'm-1', role: 'user', kind: 'user_input', content: '咖啡', createdAt: '2026-09-28T00:00:00.000Z' },
        }],
        tasks: [],
        memories: [],
      };
    },
  });
  assert.equal(service.search({ query: '咖啡' }).hits.length, 1);
  assert.equal(service.search({ query: '咖' }).hits.length, 1);
  assert.equal(reads, 1);
  stamp = 'v2';
  assert.equal(service.search({ query: '咖啡' }).hits.length, 1);
  assert.equal(reads, 2);
});
