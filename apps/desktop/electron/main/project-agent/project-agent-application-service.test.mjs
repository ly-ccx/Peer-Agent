import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  assert.equal(delivered[0].text, '用方案 A');
});
