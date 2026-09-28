import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateAvatar } from '@peer-agent/protocol';

import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createMemoryStore } from '../memory/memory-store.mjs';
import { createProjectRegistry } from '../project-registry.mjs';
import { createBotLifecycle } from './bot-lifecycle.mjs';
import { evaluateWorkSessionWrite } from './session-supervisor.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-12-life-'));
}

function harness(root, { enabled = () => true, spawn = null, removeWorkspace = null, moveToTrash = null, gitRun = null } = {}) {
  const folder = path.join(root, 'demo-project');
  mkdirSync(folder, { recursive: true });
  const registry = createProjectRegistry({ filePath: path.join(root, 'projects', 'registry.json') });
  const entry = registry.ensureForPath(folder);
  const conversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const memoryStore = createMemoryStore({ rootDir: root });
  const life = createBotLifecycle({
    rootDir: root,
    enabled,
    registry,
    conversationStore,
    memoryStore,
    spawn,
    removeWorkspace,
    moveToTrash,
    gitRun,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
  });
  return { folder, registry, entry, conversationStore, memoryStore, life };
}

test('懒创建档案和代理对话，第二次返回同一个对话', () => {
  const root = tempRoot();
  try {
    const { entry, conversationStore, life } = harness(root);
    const first = life.ensureBot(entry.workspaceId);
    const second = life.ensureBot(entry.workspaceId);
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.profile.agentConversationId, first.profile.agentConversationId);
    assert.equal(first.profile.displayName, 'demo-project');
    assert.deepEqual(first.profile.avatar, generateAvatar(entry.workspaceId));
    assert.equal(first.profile.status, 'active');
    const listed = conversationStore.listConversations({ roles: ['project_agent'] });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].role, 'project_agent');
    assert.equal(listed[0].id, first.profile.agentConversationId);
    const rotated = life.regenerateAvatar(entry.workspaceId);
    assert.deepEqual(rotated.profile.avatar, generateAvatar(`${entry.workspaceId}:1`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('开关关闭时不创建档案，也不创建对话', () => {
  const root = tempRoot();
  try {
    const { entry, conversationStore, life } = harness(root, { enabled: () => false });
    const result = life.ensureBot(entry.workspaceId);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROJECT_AGENT_DISABLED');
    assert.equal(existsSync(path.join(root, 'projects', entry.workspaceId, 'profile.json')), false);
    assert.equal(conversationStore.listConversations({ roles: ['project_agent'] }).length, 0);
    assert.equal(conversationStore.listConversations().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('删除只移出列表并归档，文件夹和记忆都还在', () => {
  const root = tempRoot();
  try {
    const removed = [];
    const { folder, entry, memoryStore, life } = harness(root, {
      removeWorkspace: (folderPath) => { removed.push(folderPath); },
    });
    writeFileSync(path.join(folder, 'keep.txt'), 'stay');
    const created = life.ensureBot(entry.workspaceId);
    const conversationId = created.profile.agentConversationId;
    life.recordVerifiedFindings(entry.workspaceId, [{
      text: '目录里有 keep.txt',
      sourceRefs: ['file:keep.txt'],
    }]);
    const deleted = life.deleteBot(entry.workspaceId);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.profile.status, 'archived');
    assert.deepEqual(removed, [folder]);
    assert.equal(existsSync(folder), true);
    assert.equal(readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'stay');
    const memories = memoryStore.list({ workspaceId: entry.workspaceId, scope: 'project' });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].trust, 'verified');
    const restored = life.restoreBot(entry.workspaceId);
    assert.equal(restored.profile.status, 'active');
    assert.equal(restored.profile.agentConversationId, conversationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('受管文件夹未确认时不进废纸篓，确认后只调用注入实现', () => {
  const root = tempRoot();
  try {
    const removed = [];
    const trashed = [];
    const { folder, entry, life } = harness(root, {
      removeWorkspace: (folderPath) => { removed.push(folderPath); },
      moveToTrash: (folderPath) => { trashed.push(folderPath); },
    });
    writeFileSync(path.join(folder, 'keep.txt'), 'stay');
    life.ensureBot(entry.workspaceId, { managed: true });
    const denied = life.deleteBot(entry.workspaceId);
    assert.equal(denied.code, 'CONFIRM_REQUIRED');
    assert.equal(trashed.length, 0);
    assert.equal(removed.length, 0);
    assert.equal(life.readProfile(entry.workspaceId).status, 'active');
    const confirmed = life.deleteBot(entry.workspaceId, { confirmManaged: true });
    assert.equal(confirmed.ok, true);
    assert.deepEqual(trashed, [folder]);
    assert.deepEqual(removed, [folder]);
    assert.equal(confirmed.profile.status, 'archived');
    assert.equal(existsSync(path.join(folder, 'keep.txt')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('熟悉非空项目只开只读任务，git 事实由宿主提供', () => {
  const root = tempRoot();
  try {
    const spawned = [];
    const { folder, entry, life } = harness(root, {
      spawn: (task) => { spawned.push(task); },
      gitRun(_folder, args) {
        const command = args.join(' ');
        if (command === 'branch --show-current') return 'main';
        if (command === 'rev-parse HEAD') return 'abc123';
        return '';
      },
    });
    mkdirSync(path.join(folder, 'src'));
    writeFileSync(path.join(folder, 'src', 'a.txt'), 'hello');
    life.ensureBot(entry.workspaceId);
    const started = life.startFamiliarize(entry.workspaceId);
    assert.equal(started.ok, true);
    assert.equal(started.plan.kind, 'research');
    assert.equal(started.plan.task.readOnly, true);
    assert.equal(started.plan.task.allowedCapabilities.some((id) => /write|edit|shell/.test(id)), false);
    assert.match(started.plan.task.brief, /当前分支：main/);
    assert.match(started.plan.task.brief, /abc123/);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].readOnly, true);
    assert.equal(spawned[0].kind, 'research');
    const blocked = evaluateWorkSessionWrite(
      { delegationOrigin: { readOnly: true } },
      { capabilityId: 'local.file.write', toolName: 'write_file', permissionKind: 'file-write' },
    );
    assert.equal(blocked.allowed, false);
    const allowed = evaluateWorkSessionWrite(
      { delegationOrigin: { readOnly: true } },
      { capabilityId: 'local.file.read', toolName: 'read_file' },
    );
    assert.equal(allowed.allowed, true);
    life.startFamiliarize(entry.workspaceId);
    assert.equal(spawned.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有证据引用时不写记忆，有证据的事实是 verified', () => {
  const root = tempRoot();
  try {
    const { entry, memoryStore, life } = harness(root);
    life.ensureBot(entry.workspaceId);
    const rejected = life.recordVerifiedFindings(entry.workspaceId, [
      { text: '有证据的事实', sourceRefs: ['file:package.json'] },
      { text: '没有证据', sourceRefs: [] },
    ]);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'SOURCE_REFS_REQUIRED');
    assert.equal(memoryStore.list({ workspaceId: entry.workspaceId, scope: 'project' }).length, 0);
    const written = life.recordVerifiedFindings(entry.workspaceId, [{
      text: '有 package.json',
      sourceRefs: ['file:package.json'],
    }]);
    assert.equal(written.ok, true);
    assert.equal(written.items[0].trust, 'verified');
    assert.deepEqual(written.items[0].sourceRefs, ['file:package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空白机器人先问职责，回答是 stated 且固定，同意后才有写 README 的任务', () => {
  const root = tempRoot();
  try {
    const spawned = [];
    const { folder, entry, conversationStore, life } = harness(root, {
      spawn: (task) => { spawned.push(task); },
    });
    writeFileSync(path.join(folder, '.gitkeep'), '');
    const created = life.ensureBot(entry.workspaceId);
    const started = life.startFamiliarize(entry.workspaceId);
    assert.equal(started.plan.kind, 'blank');
    assert.equal(started.plan.task, null);
    assert.equal(spawned.length, 0);
    const history = conversationStore.getPersistedConversationHistory(created.profile.agentConversationId);
    assert.equal(history.messages.some((message) => message.content === '这个机器人主要负责什么'), true);
    const accepted = life.acceptResponsibility(entry.workspaceId, { text: '整理每周资料' });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.item.kind, 'responsibility');
    assert.equal(accepted.item.trust, 'stated');
    assert.equal(accepted.item.pinned, true);
    assert.equal(accepted.item.sourceRefs.length > 0, true);
    const offer = accepted.cards.find((card) => card.kind === 'readme_offer');
    assert.equal(offer.resolvedState, 'open');
    assert.equal(offer.content, '要不要为这个项目写一份 README');
    assert.equal(offer.actions[0].id, 'accept_readme');
    const readme = life.acceptReadme(entry.workspaceId);
    assert.equal(readme.task.kind, 'docs');
    assert.match(readme.task.brief, /整理每周资料/);
    assert.equal(existsSync(path.join(folder, 'README.md')), false);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].kind, 'docs');
    assert.equal(spawned[0].readOnly, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('批量确保用设置里的名字，第二次还是同一个对话，并且不自动熟悉', () => {
  const root = tempRoot();
  try {
    const { folder, registry, conversationStore, memoryStore } = harness(root);
    const other = path.join(root, 'notes');
    mkdirSync(other);
    const spawned = [];
    const life = createBotLifecycle({
      rootDir: root,
      registry,
      conversationStore,
      memoryStore,
      spawn: (input) => { spawned.push(input); },
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    });
    const first = life.ensureBots([
      { path: folder, name: '演示项目' },
      { path: other, name: '笔记' },
    ]);
    assert.equal(first.ok, true);
    assert.equal(first.bots.length, 2);
    assert.equal(first.bots[0].displayName, '演示项目');
    assert.equal(first.bots[0].familiarize, null);
    assert.equal(first.bots[0].created, true);
    assert.equal(first.bots[1].displayName, '笔记');
    const second = life.ensureBots([
      { path: folder, name: '演示项目' },
      { path: other, name: '笔记' },
    ]);
    assert.equal(second.bots[0].created, false);
    assert.equal(second.bots[0].agentConversationId, first.bots[0].agentConversationId);
    assert.equal(second.bots[1].agentConversationId, first.bots[1].agentConversationId);
    assert.equal(spawned.length, 0);
    assert.equal(conversationStore.listConversations({ roles: ['project_agent'] }).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('开关关闭时批量确保不创建档案和对话', () => {
  const root = tempRoot();
  try {
    const { folder, entry, conversationStore, life } = harness(root, { enabled: () => false });
    const result = life.ensureBots([{ path: folder, name: '演示项目' }]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROJECT_AGENT_DISABLED');
    assert.equal(existsSync(path.join(root, 'projects', entry.workspaceId, 'profile.json')), false);
    assert.equal(conversationStore.listConversations().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
