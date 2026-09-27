import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectAgentIpcRegistrations } from './register-project-agent-ipc.mjs';

const CHANNELS = [
  'project-agent:list',
  'project-agent:get',
  'project-agent:create',
  'project-agent:update-profile',
  'project-agent:delete',
  'project-agent:submit-input',
  'project-agent:read-conversation',
  'project-agent:list-sessions',
  'project-agent:get-session',
  'project-agent:cancel-session',
  'project-agent:list-approvals',
  'project-agent:decide-approval',
  'project-agent:mark-read',
  'project-agent:search',
];

function harness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return { ok: true, name };
  };
  const [registration] = createProjectAgentIpcRegistrations({
    projectAgent: {
      list: port('list'),
      get: port('get'),
      create: port('create'),
      updateProfile: port('update-profile'),
      deleteBot: port('delete'),
      submitInput: port('submit-input'),
      readConversation: port('read-conversation'),
      listSessions: port('list-sessions'),
      getSession: port('get-session'),
      cancelSession: port('cancel-session'),
      listApprovals: port('list-approvals'),
      decideApproval: port('decide-approval'),
      markRead: port('mark-read'),
      search: port('search'),
    },
  });
  const handlers = new Map();
  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  return { registration, handlers, calls };
}

test('project-agent-ipc 注册全部项目代理通道', () => {
  const { registration, handlers } = harness();
  assert.equal(registration.owner, 'project-agent-ipc');
  assert.deepEqual([...handlers.keys()], CHANNELS);
});

test('每个通道把载荷交给应用服务，创建和改档案带上发送方', async () => {
  const { handlers, calls } = harness();
  const sender = { id: 7 };
  for (const channel of CHANNELS) {
    const payload = { channel };
    if (channel === 'project-agent:create' || channel === 'project-agent:update-profile') {
      await handlers.get(channel)({ sender }, payload);
    } else {
      await handlers.get(channel)({ sender }, payload);
    }
  }
  assert.equal(calls.length, CHANNELS.length);
  assert.deepEqual(calls[2], ['create', { channel: 'project-agent:create' }, sender]);
  assert.deepEqual(calls[3], ['update-profile', { channel: 'project-agent:update-profile' }, sender]);
  assert.deepEqual(calls[0], ['list', { channel: 'project-agent:list' }]);
  assert.equal(calls.some((call) => call[0] === 'submit-input'), true);
  assert.equal(calls.some((call) => call[0] === 'decide-approval'), true);
});
