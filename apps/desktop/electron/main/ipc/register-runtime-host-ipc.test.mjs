import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeHostIpcRegistrations } from './register-runtime-host-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const registrations = createRuntimeHostIpcRegistrations({
    shell: {
      openPath: port('open-path'),
      listEditors: port('list-editors'),
      setDefaultEditor: port('set-default-editor'),
      listTasks: port('list-tasks'),
      stopActiveTask: port('stop-active-task'),
      stopTask: port('stop-task'),
      listPermissionRules: port('list-permissions'),
      addPermissionRule: port('add-permission'),
    },
    clientTool: {
      execute: port('execute-client-tool'),
    },
  });
  const handlers = new Map();
  const owners = [];
  for (const descriptor of registrations) {
    owners.push(descriptor.owner);
    descriptor.register({
      handle(channel, listener) {
        assert.equal(handlers.has(channel), false, `duplicate handle: ${channel}`);
        handlers.set(channel, listener);
      },
    });
  }
  return { calls, handlers, owners };
}

test('runtime host owners register the exact nine invoke channels', () => {
  const { handlers, owners } = createHarness();
  assert.deepEqual(owners, ['shell-ipc', 'client-tool-ipc']);
  assert.deepEqual([...handlers.keys()].sort(), [
    'client-tool:execute',
    'shell:editors:list',
    'shell:editors:set-default',
    'shell:open-path',
    'shell:permissions:add',
    'shell:permissions:list',
    'shell:tasks:list',
    'shell:tasks:stop',
    'shell:tasks:stop-active',
  ]);
});

test('runtime host handlers preserve payload mapping and defaults', async () => {
  const { calls, handlers } = createHarness();
  const payload = { taskId: 'task-1', call: { name: 'bash' } };

  assert.equal(await handlers.get('shell:open-path')({}, undefined), 'open-path');
  assert.equal(handlers.get('shell:editors:list')({}), 'list-editors');
  // set-default 只把 editorId 透给端口，而不是整个 payload。
  assert.equal(
    handlers.get('shell:editors:set-default')({}, { editorId: 'vscode' }),
    'set-default-editor',
  );
  assert.equal(handlers.get('shell:editors:set-default')({}, undefined), 'set-default-editor');
  assert.equal(handlers.get('shell:tasks:list')({}), 'list-tasks');
  assert.equal(handlers.get('shell:tasks:stop-active')({}), 'stop-active-task');
  assert.equal(handlers.get('shell:tasks:stop')({}, payload), 'stop-task');
  assert.equal(handlers.get('shell:tasks:stop')({}, { toolCallId: 'call-1' }), 'stop-task');
  assert.equal(handlers.get('shell:permissions:list')({}), 'list-permissions');
  assert.equal(handlers.get('shell:permissions:add')({}, payload), 'add-permission');
  assert.equal(handlers.get('client-tool:execute')({}, payload), 'execute-client-tool');

  assert.deepEqual(calls, [
    ['open-path', {}],
    ['list-editors'],
    ['set-default-editor', 'vscode'],
    ['set-default-editor', undefined],
    ['list-tasks'],
    ['stop-active-task'],
    ['stop-task', 'task-1'],
    ['stop-task', 'call-1'],
    ['list-permissions'],
    ['add-permission', payload],
    ['execute-client-tool', payload],
  ]);
});
