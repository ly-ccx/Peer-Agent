import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceIpcRegistrations } from './register-workspace-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const [registration] = createWorkspaceIpcRegistrations({
    workspace: {
      listWorkspaces: port('list'),
      ensureDefaultWorkspace: port('ensure-default'),
      addWorkspace: port('add'),
      setActiveWorkspace: port('set-active'),
      removeWorkspace: port('remove'),
      getWorkspaceInfo: port('info'),
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

test('workspace-ipc owns the exact workspace channel set', () => {
  const { registration, handlers } = createHarness();
  assert.equal(registration.owner, 'workspace-ipc');
  assert.deepEqual([...handlers.keys()], [
    'workspace:list',
    'workspace:ensure-default',
    'workspace:add',
    'workspace:set-active',
    'workspace:remove',
    'workspace:info',
  ]);
});

test('workspace-ipc projects sender and path payloads into the service', async () => {
  const { handlers, calls } = createHarness();
  const sender = { id: 4 };

  handlers.get('workspace:list')({ sender });
  handlers.get('workspace:ensure-default')({ sender });
  await handlers.get('workspace:add')({ sender });
  handlers.get('workspace:set-active')({ sender }, { path: '/active' });
  handlers.get('workspace:remove')({ sender }, { path: '/removed' });
  handlers.get('workspace:info')({ sender }, { path: '/info' });

  assert.deepEqual(calls, [
    ['list'],
    ['ensure-default'],
    ['add', sender],
    ['set-active', '/active'],
    ['remove', '/removed'],
    ['info', '/info'],
  ]);
});
