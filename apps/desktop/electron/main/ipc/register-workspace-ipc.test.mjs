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
      updateWorkspace: port('update'),
      addLinkedFolder: port('add-linked-folder'),
      removeLinkedFolder: port('remove-linked-folder'),
      setPrimaryFolder: port('set-primary'),
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
    'workspace:update',
    'workspace:add-linked-folder',
    'workspace:remove-linked-folder',
    'workspace:set-primary',
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
  handlers.get('workspace:update')({ sender }, { path: '/updated', name: 'New' });
  await handlers.get('workspace:add-linked-folder')({ sender }, { path: '/updated' });
  handlers.get('workspace:remove-linked-folder')({ sender }, { path: '/updated', folderPath: '/extra' });
  handlers.get('workspace:set-primary')({ sender }, { path: '/updated', folderPath: '/extra' });
  handlers.get('workspace:info')({ sender }, { path: '/info' });

  assert.deepEqual(calls, [
    ['list'],
    ['ensure-default'],
    ['add', sender],
    ['set-active', '/active'],
    ['remove', '/removed'],
    ['update', { path: '/updated', name: 'New' }],
    ['add-linked-folder', sender, { path: '/updated' }],
    ['remove-linked-folder', { path: '/updated', folderPath: '/extra' }],
    ['set-primary', { path: '/updated', folderPath: '/extra' }],
    ['info', '/info'],
  ]);
});
