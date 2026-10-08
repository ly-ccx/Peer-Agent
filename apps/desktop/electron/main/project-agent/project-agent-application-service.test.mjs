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
  ['readAvatar', { workspaceId: 'ws-1' }],
  ['create', { kind: 'managed', name: '笔记' }],
  ['updateProfile', { workspaceId: 'ws-1', displayName: '新名字' }],
  ['deleteBot', { workspaceId: 'ws-1' }],
  ['submitInput', { workspaceId: 'ws-1', inputId: 'in-1', text: '你好' }],
  ['readConversation', { workspaceId: 'ws-1' }],
  ['stopResponse', { workspaceId: 'ws-1', turnId: 't' }],
  ['listSessions', { workspaceId: 'ws-1' }],
  ['getSession', { sessionId: 'sess-1' }],
  ['cancelSession', { sessionId: 'sess-1' }],
  ['resumeSession', { sessionId: 'sess-1', workspaceId: 'ws-1', requestId: 'request' }],
  ['listApprovals', { workspaceId: 'ws-1' }],
  ['decideApproval', { workspaceId: 'ws-1', approvalId: 'ap-1', decision: 'approve' }],
  ['markRead', { workspaceId: 'ws-1' }],
  ['search', { query: '笔记' }],
  ['listHistory', { workspaceId: 'ws-1' }],
  ['continueHistory', { workspaceId: 'ws-1', conversationId: 'conv-1' }],
  ['startFamiliarize', { workspaceId: 'ws-1' }],
];

test('completion review dispatch is local, workspace scoped, and failures refresh obsolete cards', async () => {
  const calls = [], events = [], scheduled = [];
  const service = createProjectAgentApplicationService({ enabled: () => true,
    sessions: { get: () => ({ workspaceId: 'w' }), async confirmCompletion(input) {
      calls.push(['manual', input]); return { ok: false, error: 'stale_completion_review' };
    }, async confirmResult(id) { calls.push(['result', id]); return { ok: true }; } },
    directory: { list: () => [] }, broadcast: (channel, payload) => events.push({ channel, payload }),
    schedule: fn => { scheduled.push(fn); return 1; },
  });
  assert.equal((await service.confirmResult({ workspaceId: 'other', sessionId: 's', stage: 'manual_completion', reviewToken: 't' })).code, 'NOT_FOUND');
  assert.equal((await service.confirmResult({ workspaceId: 'w', sessionId: 's', stage: 'unknown' })).code, 'INVALID_INPUT');
  assert.equal(calls.length, 0);
  assert.equal((await service.confirmResult({ workspaceId: 'w', sessionId: 's', stage: 'manual_completion', reviewToken: 't' })).code, 'stale_completion_review');
  assert.deepEqual(calls[0], ['manual', { sessionId: 's', reviewToken: 't' }]);
  scheduled.forEach(fn => fn());
  assert.ok(events.some(event => event.channel === 'project-agent:conversation-changed'));
  assert.equal((await service.confirmResult({ workspaceId: 'w', sessionId: 's' })).ok, true);
  assert.deepEqual(calls[1], ['result', 's']);
});

test('desktop persists the local plan decision before resuming its task', async () => {
  let record = { approvalId: 'plan:s', workspaceId: 'w', sessionId: 's', planId: 'p',
    kind: 'plan_approval', capabilityId: 'goal.plan', state: 'open' };
  const order = [];
  const service = createProjectAgentApplicationService({ enabled: () => true,
    approvals: { list: () => [record], append(row) { order.push('save'); record = row; return row; } },
    sessions: { get: () => ({ status: 'awaiting_approval' }), async resumeFromApproval(current) {
      order.push('resume'); assert.equal(record.state, 'approved'); assert.equal(current.decidedBy, 'local_ui');
      assert.equal(current.decidedAt, record.decidedAt); return { ok: true };
    } }, directory: { list: () => [], search: () => [] }, schedule: () => 1,
    now: () => '2026-10-02T04:00:00.000Z',
  });
  const result = await service.decideApproval({ workspaceId: 'w', approvalId: 'plan:s', decision: 'approve' });
  assert.equal(result.resumed?.ok, true);
  assert.deepEqual(order, ['save', 'resume']);
});

test('desktop replays an already persisted approval only while the plan still awaits admission', async () => {
  for (const phase of ['awaiting_approval', 'running', 'paused', 'superseded', 'queued']) {
    let resumed = 0;
    const record = { approvalId: 'plan:s', sessionId: 's', state: 'approved', capabilityId: 'goal.plan' };
    const service = createProjectAgentApplicationService({ enabled: () => true,
      approvals: { list: () => [record], append() { throw Error('no rewrite'); } },
      sessions: { get: () => ({ origin: { phase } }), async resumeFromApproval() { resumed++; return { ok: true }; } },
    });
    assert.equal((await service.decideApproval({ approvalId: 'plan:s', decision: 'approve' })).ok, true);
    assert.equal(resumed, phase === 'awaiting_approval' ? 1 : 0);
    await service.decideApproval({ approvalId: 'plan:s', decision: 'deny' });
    assert.equal(resumed, phase === 'awaiting_approval' ? 1 : 0);
  }
});

test('desktop never resumes a plan if persisting the decision fails', async () => {
  let resumed = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    approvals: { list: () => [{ approvalId: 'plan:s', sessionId: 's', state: 'open' }], append() { throw Error('disk failure'); } },
    sessions: { get: () => ({}), resumeFromApproval() { resumed++; } },
  });
  await assert.rejects(service.decideApproval({ approvalId: 'plan:s', decision: 'approve' }), /disk failure/);
  assert.equal(resumed, 0);
});

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
        query: throwing('query'),
        get: throwing('get'),
        search: throwing('search'),
        readConversation: throwing('read'),
        markRead: throwing('mark'),
      },
      lifecycle: {
        ensureBot: throwing('ensure'),
        startFamiliarize: throwing('familiarize'),
        regenerateAvatar: throwing('avatar'),
        setAvatarColor: throwing('color'),
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

test('头像选色通过宿主保存并返回最新档案', async () => {
  const calls = [];
  let profile = { workspaceId: 'ws-1', status: 'active', avatar: { kind: 'generated', shape: 'circle', color: '#6474e5', variant: 0 } };
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    profileStore: { read: () => profile },
    lifecycle: {
      setAvatarColor(workspaceId, color) {
        calls.push([workspaceId, color]);
        profile = { ...profile, avatar: { ...profile.avatar, color } };
        return { ok: true, profile };
      },
    },
  });
  const result = await service.updateProfile({ workspaceId: 'ws-1', avatarColor: '#61b68c' });
  assert.equal(result.ok, true);
  assert.equal(result.profile.avatar.color, '#61b68c');
  assert.deepEqual(calls, [['ws-1', '#61b68c']]);
});

test('automatic merge is explicit, saved through host policy, and invalid patches are atomic', async () => {
  let profile = { workspaceId: 'ws-1', status: 'active', displayName: 'Bot' };
  let saves = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    profileStore: { read: () => profile, save: next => { saves++; profile = next; return { ok: true }; } } });
  assert.equal((await service.updateProfile({ workspaceId: 'ws-1', displayName: 'Changed', autoHandoffOnPolicyAccept: 'true' })).ok, false);
  assert.equal(saves, 0); assert.equal(profile.displayName, 'Bot');
  const result = await service.updateProfile({ workspaceId: 'ws-1', autoHandoffOnPolicyAccept: true });
  assert.equal(result.ok, true); assert.equal(result.profile.autoHandoffOnPolicyAccept, true);
  assert.equal((await service.updateProfile({ workspaceId: 'ws-1', autoHandoffOnPolicyAccept: false })).profile.autoHandoffOnPolicyAccept, false);
});

test('failed handoff cleanup stays actionable and does not acknowledge a successful card decision', async () => {
  const inputs = [];
  let relays = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    inputQueue: { submitInput: input => { inputs.push(input); return input; } },
    sessions: { handleHandoffAnswer: async () => ({ handled: true, error: 'cleanup_failed' }),
      deliverAnswer: () => { relays++; } } });
  const result = await service.submitInput({ workspaceId: 'w', text: '放弃这次改动', answerTo: 'card:question:s:handoff_conflict-current' });
  assert.equal(result.ok, false); assert.equal(result.code, 'HANDOFF_FAILED');
  assert.equal(inputs.length, 1); assert.equal(result.input, inputs[0]);
  assert.equal(relays, 0);
  assert.match(result.message, /保留/);
});

test('头像展示只读取已保存图片，由主进程编码为 data URL', () => {
  const calls = [];
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    profileStore: {
      readAvatar(workspaceId) {
        calls.push(workspaceId);
        return workspaceId === 'ws-1'
          ? { ok: true, mime: 'image/png', bytes: Buffer.from([1, 2, 3]) }
          : { ok: false, code: 'NOT_FOUND' };
      },
    },
  });
  assert.deepEqual(service.readAvatar({ workspaceId: 'ws-1', path: '/etc/passwd' }), {
    ok: true,
    dataUrl: 'data:image/png;base64,AQID',
  });
  assert.deepEqual(service.readAvatar({ workspaceId: 'missing' }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(calls, ['ws-1', 'missing']);
});

test('列表与单项只投影本进程已知的代理状态', () => {
  const item = {
    workspaceId: 'ws-1',
    state: { needsYou: 0, unread: 0, running: 0 },
  };
  let status = 'thinking';
  const service = createProjectAgentApplicationService({
    enabled: () => true,
    directory: {
      list: () => [item],
      get: () => ({ ok: true, item }),
      search: () => [item],
    },
    readAgentStatus: () => status,
  });
  assert.equal(service.list().items[0].state.agentStatus, 'thinking');
  status = 'waiting_provider';
  assert.equal(service.get({ workspaceId: 'ws-1' }).item.state.agentStatus, 'waiting_provider');
  status = undefined;
  assert.equal('agentStatus' in service.list().items[0].state, false);
  assert.equal('agentStatus' in item.state, false);
});

test('100ms 内的多次变化合并成一次，并带上全部 workspaceId', async () => {
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
  await service.deleteBot({ workspaceId: 'ws-2' });
  service.markRead({ workspaceId: 'ws-1' });
  assert.equal(events.length, 0);
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'project-agent:changed');
  assert.deepEqual(events[0].payload.workspaceIds, ['ws-1', 'ws-2']);
});

test('unchanged read receipt retains viewing presence without broadcasting another refresh', () => {
  const scheduled = [], viewing = [];
  let changed = true;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    directory: { markRead: () => ({ ok: true, at: 'now', messageId: 'last', changed }) },
    schedule: fn => { scheduled.push(fn); return 1; }, onViewing: id => viewing.push(id) });
  assert.deepEqual(service.markRead({ workspaceId: 'ws-1' }), { ok: true, at: 'now', messageId: 'last' });
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  changed = false;
  assert.deepEqual(service.markRead({ workspaceId: 'ws-1' }), { ok: true, at: 'now', messageId: 'last' });
  assert.equal(scheduled.length, 0);
  assert.deepEqual(viewing, ['ws-1', 'ws-1']);
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

test('search reuses the full query catalog while retaining nonmatching bot message hits', () => {
  const catalog = [
    { workspaceId: 'ws-1', profile: { displayName: 'Alpha' }, preview: '' },
    { workspaceId: 'ws-2', profile: { displayName: 'Beta' }, preview: '' },
  ];
  let projections = 0, reads = 0, stamp = 'v1';
  const service = createProjectAgentApplicationService({ enabled: () => true,
    directory: {
      query: () => { projections++; return { items: [], catalog }; },
      search: throwing('duplicate directory projection'),
    }, corpusStamp: (snapshot) => { assert.equal(snapshot, catalog); return stamp; },
    readSearchCorpus: (snapshot) => {
      assert.equal(snapshot, catalog); reads++;
      return { bots: snapshot, messages: [{ workspaceId: 'ws-2',
        message: { id: 'message-beta', kind: 'user_input', role: 'user', content: 'needle in an unmatched bot' } }] };
    },
  });
  assert.equal(service.search({ query: 'needle' }).hits[0].workspaceId, 'ws-2');
  assert.equal(projections, 1); assert.equal(reads, 1);
  service.search({ query: 'needle' });
  assert.equal(projections, 2); assert.equal(reads, 1);
  stamp = 'v2'; service.search({ query: 'needle' });
  assert.equal(projections, 3); assert.equal(reads, 2, 'changed source facts must refresh the index');
});

test('restoration click creates one durable user anchor and refuses cross-project or offline actions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-03-restore-'));
  try {
    const store = createConversationStore({ storeDir: root });
    const parent = store.createConversation({ title: 'project', role: 'project_agent', workspaceId: 'ws-1' });
    const calls = []; let online = true; let archived = false;
    const service = createProjectAgentApplicationService({ enabled: () => true, conversationStore: store,
      agentOnline: () => online, profileStore: { read: () => ({ status: archived ? 'archived' : 'active', agentConversationId: parent.id }) },
      sessions: { get: () => ({ sessionId: 's1', workspaceId: 'ws-1', title: 'old', status: 'superseded', origin: { parentConversationId: parent.id } }),
        resume: (input, context) => { calls.push([input, context]); return { sessionId: 's1', status: 'queued' }; } } });
    const payload = { sessionId: 's1', workspaceId: 'ws-1', requestId: 'request-1' };
    assert.equal((await service.resumeSession({ ...payload, workspaceId: 'other' })).code, 'OUT_OF_SCOPE');
    archived = true; assert.equal((await service.resumeSession(payload)).code, 'OUT_OF_SCOPE'); archived = false;
    online = false; assert.equal((await service.resumeSession(payload)).code, 'AGENT_OFFLINE');
    assert.equal(store.getPersistedConversationHistory(parent.id).messages.length, 0);
    online = true;
    assert.equal((await service.resumeSession(payload)).ok, true);
    assert.equal((await service.resumeSession(payload)).ok, true);
    const messages = store.getPersistedConversationHistory(parent.id).messages;
    assert.equal(messages.length, 1); assert.equal(messages[0].kind, 'user_input'); assert.equal(messages[0].role, 'user');
    assert.equal(calls[0][0].anchorMessageId, messages[0].id);
    assert.equal(calls[0][1].parentConversationId, parent.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an approval cannot accidentally restart a superseded task', async () => {
  let approved = 0; let resumed = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    approvals: { list: () => [{ approvalId: 'plan:s1', sessionId: 's1', state: 'open' }], append: () => { approved++; } },
    sessions: { get: () => ({ status: 'superseded' }), resumeFromApproval: () => { resumed++; } } });
  assert.equal((await service.decideApproval({ workspaceId: 'ws-1', approvalId: 'plan:s1', decision: 'approve' })).code, 'SESSION_PAUSED');
  assert.equal(approved, 0); assert.equal(resumed, 0);
});


test('paused approvals can be denied without restarting the task', async () => {
  for (const state of ['open', 'stale']) for (const status of ['paused', 'superseded']) {
    const saved = [], settled = [], cancelled = []; let restarts = 0;
    const permission = { approvalId: 'permission-1', capabilityId: 'local.fs.write', sessionId: 's1', state };
    const plan = { approvalId: 'plan:s1', sessionId: 's1', state };
    const service = createProjectAgentApplicationService({ enabled: () => true,
      approvals: { list: () => [permission, plan], append: item => { saved.push(item); return item; } },
      settleLive: (_approval, decision) => settled.push(decision),
      sessions: { get: () => ({ status }), resumeFromApproval: () => { restarts++; },
        cancel: input => { cancelled.push(input); return { sessionId: 's1', status: 'cancelled' }; } } });
    assert.equal((await service.decideApproval({ approvalId: permission.approvalId, decision: 'deny' })).approval?.state, 'denied');
    assert.equal((await service.decideApproval({ approvalId: plan.approvalId, decision: 'reject' })).approval?.state, 'denied');
    assert.equal(saved.length, 2); assert.equal(cancelled.length, 1); assert.equal(restarts, 0);
    assert.equal(settled.length, state === 'open' ? 1 : 0);
  }
});


test('response stopping validates workspace and exact turn, delegates host authority, and reads current activity', async () => {
  const calls = [], activity = { workspaceId: 'w', turnId: 't', revision: 2, phase: 'responding' };
  const service = createProjectAgentApplicationService({ enabled: () => true,
    directory: { get: id => id === 'w' ? { ok: true, item: { workspaceId: id } } : null,
      readConversation: () => ({ ok: true, messages: [] }) },
    readActivity: () => activity,
    stopResponseTurn: payload => { calls.push(payload); return { ok: false, code: 'HOST_OFFLINE' }; },
  });
  assert.equal(service.stopResponse({ workspaceId: 'w', turnId: '' }).code, 'INVALID_INPUT');
  assert.equal(service.stopResponse({ workspaceId: 'other', turnId: 't' }).code, 'NOT_FOUND');
  assert.equal(service.stopResponse({ workspaceId: 'w', turnId: 't' }).code, 'HOST_OFFLINE');
  assert.deepEqual(calls, [{ workspaceId: 'w', turnId: 't' }]);
  assert.equal(service.readConversation({ workspaceId: 'w' }).activity, activity);
});

test('desktop forwards uploads on the existing input queue seam, including attachment-only input', async () => {
  let submitted;
  const service = createProjectAgentApplicationService({ enabled: () => true,
    inputQueue: { submitInput(value) { submitted = value; return value; } },
  });
  const attachments = [{ id: 'file', name: 'brief.txt', mimeType: 'text/plain', size: 4,
    kind: 'text', sourceKind: 'user_upload', text: 'fact' }];
  const result = await service.submitInput({ workspaceId: 'w', inputId: 'i', text: '', attachments });
  assert.equal(result.ok, true);
  assert.deepEqual(submitted.attachments, attachments);
  assert.equal(submitted.text, '');
});
