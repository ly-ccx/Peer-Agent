import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBotProfileStore, createMemoryStore } from '@peer-agent/runtime-node';

import { memoryUseEnabled } from '../project-agent/memory-gate-port.mjs';
import { createProjectMemoryService } from '../project-agent/project-memory-service.mjs';
import { createProjectMemoryIpcRegistrations } from './register-project-memory-ipc.mjs';

const CHANNELS = [
  'project-memory:list',
  'project-memory:pin',
  'project-memory:forget',
  'project-memory:restore',
  'project-memory:edit',
  'project-memory:export',
  'project-memory:set-switches',
];

function harness(root) {
  const store = createMemoryStore({ rootDir: root });
  const profileStore = createBotProfileStore({ rootDir: root });
  profileStore.create({
    workspaceId: 'ws-1',
    displayName: '登录',
    agentConversationId: 'conv-1',
  });
  const settings = { memory: { enabled: true, learnPreferences: true } };
  const memory = createProjectMemoryService({
    store,
    profileStore,
    getSettings: () => settings,
    mergeSettings(partial) {
      settings.memory = { ...settings.memory, ...partial.memory };
      return settings;
    },
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'export.json') }),
  });
  const [registration] = createProjectMemoryIpcRegistrations({ memory });
  const handlers = new Map();
  registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  return { registration, handlers, store, settings, profileStore };
}

test('project-memory-ipc 注册全部记忆通道', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-06-ipc-'));
  try {
    const { registration, handlers } = harness(root);
    assert.equal(registration.owner, 'project-memory-ipc');
    assert.deepEqual([...handlers.keys()], CHANNELS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('记忆页的每个动作都经 IPC 落到存储', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-06-actions-'));
  try {
    const { handlers, store, settings, profileStore } = harness(root);
    const saved = store.rememberStated({
      workspaceId: 'ws-1',
      kind: 'fact',
      text: '登录页在 src/login.tsx',
      anchorMessageId: 'm-user',
      messages: [{ id: 'm-user', kind: 'user_input', content: '记住' }],
    });
    assert.equal(saved.ok, true);
    const listed = await handlers.get('project-memory:list')({}, { workspaceId: 'ws-1' });
    assert.equal(listed.ok, true);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.switches.useMemory, true);
    assert.equal(listed.switches.learnPreferences, true);
    assert.equal(listed.switches.memoryEnabled, true);

    const pinned = await handlers.get('project-memory:pin')({}, {
      workspaceId: 'ws-1',
      id: saved.item.id,
      pinned: true,
    });
    assert.equal(pinned.item.pinned, true);
    const unpinned = await handlers.get('project-memory:pin')({}, {
      workspaceId: 'ws-1',
      id: saved.item.id,
      pinned: false,
    });
    assert.equal(unpinned.item.pinned, false);

    const forgotten = await handlers.get('project-memory:forget')({}, {
      workspaceId: 'ws-1',
      id: saved.item.id,
    });
    assert.equal(forgotten.item.status, 'forgotten');
    const restored = await handlers.get('project-memory:restore')({}, {
      workspaceId: 'ws-1',
      id: saved.item.id,
    });
    assert.equal(restored.item.status, 'active');

    const edited = await handlers.get('project-memory:edit')({}, {
      workspaceId: 'ws-1',
      id: saved.item.id,
      text: '登录页在 src/auth/login.tsx',
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.item.trust, 'stated');
    assert.equal(store.get(saved.item.id).status, 'forgotten');
    assert.deepEqual(edited.item.sourceRefs, [`edit:${saved.item.id}`]);

    const exported = await handlers.get('project-memory:export')({}, {
      workspaceId: 'ws-1',
      format: 'json',
    });
    assert.equal(exported.ok, true);
    assert.match(readFileSync(exported.path, 'utf8'), /src\/auth\/login.tsx/);
    const markdownPath = path.join(root, 'memory.md');
    const markdownService = createProjectMemoryService({
      store,
      profileStore,
      getSettings: () => settings,
      showSaveDialog: async () => ({ canceled: false, filePath: markdownPath }),
    });
    const markdown = await markdownService.exportMemory({ workspaceId: 'ws-1', format: 'markdown' });
    assert.equal(markdown.format, 'markdown');
    assert.match(readFileSync(markdownPath, 'utf8'), /# 记忆/);
    const cancelled = await createProjectMemoryService({
      store,
      profileStore,
      showSaveDialog: async () => ({ canceled: true }),
    }).exportMemory({ workspaceId: 'ws-1', format: 'json' });
    assert.equal(cancelled.code, 'CANCELLED');

    const switches = await handlers.get('project-memory:set-switches')({}, {
      workspaceId: 'ws-1',
      memoryEnabled: false,
      useMemory: false,
      learnPreferences: false,
    });
    assert.deepEqual(switches.switches, {
      memoryEnabled: false,
      useMemory: false,
      learnPreferences: false,
    });
    assert.equal(profileStore.read('ws-1').memoryEnabled, false);
    assert.equal(memoryUseEnabled({
      settings,
      profile: profileStore.read('ws-1'),
    }), false);
    assert.equal(memoryUseEnabled({ settings: {}, profile: {} }), true);

    const byId = await handlers.get('project-memory:list')({}, {
      workspaceId: 'ws-1',
      ids: [edited.item.id],
      status: 'active',
    });
    assert.deepEqual(byId.items.map((item) => item.id), [edited.item.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing restore IPC resolves conflicting memory, guards project scope and refreshes facts', async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'memory-choice-ipc-'));
  try {
    const {handlers,store}=harness(root);
    const a=store.writeVerified({workspaceId:'ws-1',kind:'fact',text:'A',sourceRefs:['ev1'],topicKey:'choice',topicValue:'a'}).item;
    const b=store.writeVerified({workspaceId:'ws-1',kind:'fact',text:'B',sourceRefs:['ev2'],topicKey:'choice',topicValue:'b'}).item;
    assert.equal((await handlers.get('project-memory:restore')({}, {workspaceId:'ws-2',id:a.id,resolveConflict:true})).ok,false);
    const changed=[];const service=createProjectMemoryService({store,onChanged:ws=>changed.push(ws)});
    assert.equal(service.restore({workspaceId:'ws-1',id:a.id}).code,'CONFLICT_CHOICE_REQUIRED');
    assert.equal(service.restore({workspaceId:'ws-1',id:b.id,resolveConflict:true}).ok,true);
    assert.deepEqual(changed,['ws-1']);assert.equal(store.get(a.id).status,'forgotten');assert.equal(store.get(b.id).status,'active');
  } finally {rmSync(root,{recursive:true,force:true});}
});
