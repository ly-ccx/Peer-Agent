import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectRegistry } from '@peer-agent/runtime-node';
import { createWorkspaceApplicationService } from './workspace-application-service.mjs';

function idFor(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function createHarness(overrides = {}) {
  const calls = [];
  let minted = 0;
  const registry = overrides.projectRegistry ?? createProjectRegistry({
    createId: () => idFor(++minted),
  });
  const existingPaths = new Set(overrides.existingPaths ?? ['/configured', '/discovered']);
  const state = {
    workspaces: overrides.workspaces ?? [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
    ],
    activeWorkspace: overrides.activeWorkspace ?? '/configured',
  };
  let selection = overrides.selection ?? null;
  const conversations = overrides.conversations ?? [
    { workspacePath: '/configured' },
    { workspacePath: '/discovered' },
    { workspacePath: '/missing' },
    { workspacePath: null },
  ];

  const service = createWorkspaceApplicationService({
    getSettings: () => state,
    mergeSettings: (patch) => {
      calls.push(['merge', structuredClone(patch)]);
      Object.assign(state, patch);
    },
    pathExists: (candidate) => existingPaths.has(candidate),
    basename: (candidate) => candidate.split('/').filter(Boolean).at(-1) || '/',
    getDefaultWorkspacePath: () => '/home/user/PeerAgent',
    ensureDirectory: (candidate) => {
      calls.push(['mkdir', candidate]);
      existingPaths.add(candidate);
    },
    chooseDirectory: async (sender) => {
      calls.push(['choose-directory', sender]);
      return selection;
    },
    setChatWorkspacePath: (candidate) => calls.push(['chat-workspace', candidate]),
    setSkillWorkspacePath: (candidate) => calls.push(['skill-workspace', candidate]),
    readProjectIndex: (options) => {
      calls.push(['read-project-index', options]);
      return overrides.projectIndex?.[options.workspaceRoot] ?? null;
    },
    nowIso: () => '2026-08-01T12:00:00.000Z',
    projectRegistry: registry,
  });

  return {
    service,
    calls,
    state,
    registry,
    conversations,
    existingPaths,
    setSelection(value) {
      selection = value;
    },
  };
}

test('lists only manually configured workspaces without conversation auto-discovery', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.listWorkspaces(), {
    workspaces: [
      { id: idFor(1), path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
    ],
    activeWorkspace: '/configured',
  });
  // 侧栏不再从会话自动发现注入工作区（/discovered 即便存在也不出现）。
  assert.deepEqual(calls, []);
});

test('removeWorkspace keeps conversations under the workspace', () => {
  const harness = createHarness({
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/discovered', name: 'discovered', addedAt: '1970-01-01T00:00:00.000Z' },
    ],
  });

  const result = harness.service.removeWorkspace('/discovered');
  assert.equal(result.activeWorkspace, '/configured');
  assert.equal(result.removedConversations, undefined);
  assert.equal(
    harness.calls.some(([name]) => name === 'delete-conversations'),
    false,
  );
  assert.deepEqual(
    harness.conversations.map((conversation) => conversation.workspacePath),
    ['/configured', '/discovered', '/missing', null],
  );

  // 移除后 listWorkspaces 不再出现该工作区（不会话自动发现注入）。
  const listed = harness.service.listWorkspaces();
  assert.deepEqual(
    listed.workspaces.map((workspace) => workspace.path),
    ['/configured'],
  );
});

test('reuses an existing active workspace without persistence or synchronization', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.ensureDefaultWorkspace(), {
    id: idFor(1),
    path: '/configured',
    name: 'configured',
    created: false,
  });
  assert.deepEqual(service.previewDefaultWorkspace(), {
    path: '/configured',
    name: 'configured',
    exists: true,
  });
  assert.deepEqual(calls, []);
});

test('creates and persists the default workspace when no active path exists', () => {
  const { service, calls, state } = createHarness({
    workspaces: [],
    activeWorkspace: null,
    existingPaths: [],
  });

  assert.deepEqual(service.ensureDefaultWorkspace(), {
    id: idFor(1),
    path: '/home/user/PeerAgent',
    name: 'PeerAgent',
    created: true,
  });
  assert.deepEqual(state, {
    workspaces: [
      {
        id: idFor(1),
        path: '/home/user/PeerAgent',
        name: 'PeerAgent',
        addedAt: '2026-08-01T12:00:00.000Z',
        linkedFolders: [],
      },
    ],
    activeWorkspace: '/home/user/PeerAgent',
  });
  assert.deepEqual(calls, [
    ['mkdir', '/home/user/PeerAgent'],
    ['merge', structuredClone(state)],
    ['chat-workspace', '/home/user/PeerAgent'],
    ['skill-workspace', '/home/user/PeerAgent'],
  ]);
});

test('directory selection preserves cancellation, existing, and new workspace behavior', async () => {
  const sender = { id: 17 };
  const harness = createHarness();

  assert.equal(await harness.service.addWorkspace(sender), null);

  harness.setSelection('/configured');
  assert.deepEqual(await harness.service.addWorkspace(sender), {
    id: idFor(1),
    path: '/configured',
    name: 'configured',
    existing: true,
  });

  harness.setSelection('/new-project');
  assert.deepEqual(await harness.service.addWorkspace(sender), {
    id: idFor(2),
    path: '/new-project',
    name: 'new-project',
    existing: false,
  });
  assert.deepEqual(harness.state, {
    workspaces: [
      { id: idFor(1), path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
      { id: idFor(2), path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z', linkedFolders: [] },
    ],
    activeWorkspace: '/new-project',
  });
  assert.deepEqual(harness.calls, [
    ['choose-directory', sender],
    ['choose-directory', sender],
    ['merge', { activeWorkspace: '/configured' }],
    ['chat-workspace', '/configured'],
    ['skill-workspace', '/configured'],
    ['choose-directory', sender],
    ['merge', {
      workspaces: [
        { id: idFor(1), path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
        { id: idFor(2), path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z', linkedFolders: [] },
      ],
      activeWorkspace: '/new-project',
    }],
    ['chat-workspace', '/new-project'],
    ['skill-workspace', '/new-project'],
  ]);
});

test('set-active synchronizes both fallbacks while removal preserves the legacy skill-only sync', () => {
  const harness = createHarness({
    workspaces: [
      { path: '/configured', name: 'Configured' },
      { path: '/other', name: 'Other' },
    ],
  });

  assert.deepEqual(harness.service.setActiveWorkspace('/other'), {
    activeWorkspace: '/other',
  });
  assert.deepEqual(harness.service.removeWorkspace('/other'), {
    workspaces: [{ id: idFor(1), path: '/configured', name: 'Configured', addedAt: '1970-01-01T00:00:00.000Z', linkedFolders: [] }],
    activeWorkspace: null,
  });
  assert.deepEqual(harness.calls, [
    ['merge', { activeWorkspace: '/other' }],
    ['chat-workspace', '/other'],
    ['skill-workspace', '/other'],
    ['merge', {
      workspaces: [{ id: idFor(1), path: '/configured', name: 'Configured', addedAt: '1970-01-01T00:00:00.000Z', linkedFolders: [] }],
      activeWorkspace: null,
    }],
    ['skill-workspace', null],
  ]);
});

test('stores, updates, and promotes linked folders without merging two projects', async () => {
  const sender = { id: 3 };
  const harness = createHarness({
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/other', name: 'Other', addedAt: '2026-01-02T00:00:00.000Z' },
    ],
  });

  assert.deepEqual(harness.service.updateWorkspace({
    path: '/configured',
    name: 'Knowledge',
    linkedFolders: [
      { path: '/configured' },
      { path: '/code' },
      { path: '/code' },
    ],
  }), {
    ok: true,
    workspace: {
      id: idFor(1),
      path: '/configured',
      name: 'Knowledge',
      addedAt: '2026-01-01T00:00:00.000Z',
      linkedFolders: [{ path: '/code', name: 'code' }],
    },
  });

  harness.setSelection('/other');
  assert.deepEqual(await harness.service.addLinkedFolder(sender, { path: '/configured' }), {
    ok: false,
    reason: 'other-project-primary',
    path: '/other',
    name: 'Other',
  });

  harness.setSelection('/docs');
  assert.deepEqual(await harness.service.addLinkedFolder(sender, { path: '/configured' }), {
    ok: true,
    existing: false,
    workspace: {
      id: idFor(1),
      path: '/configured',
      name: 'Knowledge',
      addedAt: '2026-01-01T00:00:00.000Z',
      linkedFolders: [
        { path: '/code', name: 'code' },
        { path: '/docs', name: 'docs' },
      ],
    },
  });

  assert.deepEqual(harness.service.removeLinkedFolder({
    path: '/configured',
    folderPath: '/docs',
  }), {
    ok: true,
    workspace: {
      id: idFor(1),
      path: '/configured',
      name: 'Knowledge',
      addedAt: '2026-01-01T00:00:00.000Z',
      linkedFolders: [{ path: '/code', name: 'code' }],
    },
  });

  assert.deepEqual(harness.service.setPrimaryFolder({
    path: '/configured',
    folderPath: '/code',
  }), {
    ok: true,
    workspace: {
      id: idFor(1),
      path: '/code',
      name: 'Knowledge',
      addedAt: '2026-01-01T00:00:00.000Z',
      linkedFolders: [{ path: '/configured', name: 'configured' }],
    },
  });
  assert.equal(harness.state.activeWorkspace, '/code');
});

test('ADR 79/baseBranch 字段被移除：更新时忽略传入值并清除历史残留', () => {
  const harness = createHarness({
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', baseBranch: '0.0.15' },
    ],
  });

  // 历史残留不再投影给 renderer。
  assert.equal(harness.service.listWorkspaces().workspaces[0].baseBranch, undefined);
  // 传入 baseBranch 被忽略，且顺手清除历史残留；其他字段保持不变。
  const updated = harness.service.updateWorkspace({
    path: '/configured',
    baseBranch: 'develop',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.workspace.baseBranch, undefined);
  assert.equal(updated.workspace.name, 'Configured');
  assert.deepEqual(harness.service.listWorkspaces().workspaces[0], {
    id: idFor(1),
    path: '/configured',
    name: 'Configured',
    addedAt: '2026-01-01T00:00:00.000Z',
    linkedFolders: [],
  });
  // 不传 baseBranch 的常规改名照常工作。
  assert.deepEqual(harness.service.updateWorkspace({
    path: '/configured',
    name: 'Knowledge',
  }).workspace, {
    id: idFor(1),
    path: '/configured',
    name: 'Knowledge',
    addedAt: '2026-01-01T00:00:00.000Z',
    linkedFolders: [],
  });
});

test('renaming a workspace keeps its id', () => {
  const harness = createHarness();
  const before = harness.service.listWorkspaces().workspaces[0].id;
  const renamed = harness.service.updateWorkspace({ path: '/configured', name: 'Renamed' });
  assert.equal(renamed.workspace.id, before);
  assert.equal(renamed.workspace.name, 'Renamed');
  assert.equal(harness.service.listWorkspaces().workspaces[0].id, before);
});

test('setPrimaryFolder keeps the id and records the previous path', () => {
  const harness = createHarness();
  harness.service.updateWorkspace({
    path: '/configured',
    linkedFolders: [{ path: '/code' }],
  });
  const id = harness.service.listWorkspaces().workspaces[0].id;
  const moved = harness.service.setPrimaryFolder({ path: '/configured', folderPath: '/code' });
  assert.equal(moved.ok, true);
  assert.equal(moved.workspace.id, id);
  assert.equal(moved.workspace.path, '/code');
  assert.equal(harness.registry.get(id).path, '/code');
  assert.deepEqual(harness.registry.get(id).previousPaths, ['/configured']);
});

test('removeWorkspace leaves the registry row in place', () => {
  const harness = createHarness();
  const id = harness.service.listWorkspaces().workspaces[0].id;
  harness.service.removeWorkspace('/configured');
  assert.equal(harness.service.listWorkspaces().workspaces.length, 0);
  assert.equal(harness.registry.get(id).workspaceId, id);
  assert.equal(harness.registry.get(id).path, '/configured');
});

test('reloading after an old write-back returns the same id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-workspace-id-'));
  const file = path.join(dir, 'registry.json');
  let minted = 0;
  const registry = createProjectRegistry({
    filePath: file,
    createId: () => idFor(++minted),
  });
  const first = createHarness({
    projectRegistry: registry,
    workspaces: [{ path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' }],
  });
  const id = first.service.listWorkspaces().workspaces[0].id;
  assert.equal(minted, 1);
  const reloaded = createHarness({
    projectRegistry: createProjectRegistry({
      filePath: file,
      createId: () => { throw new Error('minted'); },
    }),
    workspaces: [{ path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' }],
  });
  assert.equal(reloaded.service.listWorkspaces().workspaces[0].id, id);
  rmSync(dir, { recursive: true, force: true });
});

test('a corrupt registry is rebuilt from the cached workspace id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-workspace-id-'));
  const file = path.join(dir, 'registry.json');
  const id = idFor(4);
  writeFileSync(file, '{');
  const harness = createHarness({
    projectRegistry: createProjectRegistry({
      filePath: file,
      now: () => new Date('2026-09-26T01:02:03.000Z'),
      createId: () => { throw new Error('minted'); },
    }),
    workspaces: [{
      id,
      path: '/configured',
      name: 'Configured',
      addedAt: '2026-01-01T00:00:00.000Z',
    }],
  });
  assert.equal(harness.service.listWorkspaces().workspaces[0].id, id);
  assert.equal(
    readdirSync(dir).some((name) => name.includes('registry.json.corrupt-')),
    true,
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[0].workspaceId, id);
  rmSync(dir, { recursive: true, force: true });
});

test('returns project metadata with basename fallback', () => {
  const indexed = { name: 'Indexed', absolutePath: '/indexed' };
  const { service, calls } = createHarness({ projectIndex: { '/indexed': [indexed] } });

  assert.equal(service.getWorkspaceInfo(null), null);
  assert.equal(service.getWorkspaceInfo('/indexed'), indexed);
  assert.deepEqual(service.getWorkspaceInfo('/fallback'), {
    name: 'fallback',
    absolutePath: '/fallback',
  });
  const indexCalls = calls.filter((entry) => entry[0] === 'read-project-index');
  assert.deepEqual(indexCalls[0][1], {
    workspaceRoot: '/indexed',
    includePackages: false,
  });
});
