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

test('提交输入入队并单独通知对话变化', () => {
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
  const result = service.submitInput({ workspaceId: 'ws-9', inputId: 'in-1', text: '你好' });
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
