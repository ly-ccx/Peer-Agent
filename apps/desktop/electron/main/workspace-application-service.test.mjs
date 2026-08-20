import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceApplicationService } from './workspace-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
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
    deleteConversationsByWorkspace: (workspacePath) => {
      calls.push(['delete-conversations', workspacePath]);
      const removed = conversations.filter(
        (conversation) => conversation.workspacePath === workspacePath,
      );
      for (const conversation of removed) {
        conversations.splice(conversations.indexOf(conversation), 1);
      }
      return removed;
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
    readProjectIndex: ({ workspaceRoot }) => overrides.projectIndex?.[workspaceRoot] ?? null,
    nowIso: () => '2026-08-01T12:00:00.000Z',
  });

  return {
    service,
    calls,
    state,
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
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
    ],
    activeWorkspace: '/configured',
  });
  // 侧栏不再从会话自动发现注入工作区（/discovered 即便存在也不出现）。
  assert.deepEqual(calls, []);
});

test('removeWorkspace deletes conversations under the workspace', () => {
  const harness = createHarness({
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/discovered', name: 'discovered', addedAt: '1970-01-01T00:00:00.000Z' },
    ],
  });

  const result = harness.service.removeWorkspace('/discovered');
  assert.equal(result.activeWorkspace, '/configured');
  assert.equal(result.removedConversations, 1);
  assert.ok(
    harness.calls.some(([name, arg]) => name === 'delete-conversations' && arg === '/discovered'),
  );

  // 删除后 listWorkspaces 不再出现该工作区（不会话自动发现注入）。
  const listed = harness.service.listWorkspaces();
  assert.deepEqual(
    listed.workspaces.map((workspace) => workspace.path),
    ['/configured'],
  );
});

test('reuses an existing active workspace without persistence or synchronization', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.ensureDefaultWorkspace(), {
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
    path: '/home/user/PeerAgent',
    name: 'PeerAgent',
    created: true,
  });
  assert.deepEqual(state, {
    workspaces: [
      {
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
    path: '/configured',
    name: 'configured',
    existing: true,
  });

  harness.setSelection('/new-project');
  assert.deepEqual(await harness.service.addWorkspace(sender), {
    path: '/new-project',
    name: 'new-project',
    existing: false,
  });
  assert.deepEqual(harness.state, {
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
      { path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z', linkedFolders: [] },
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
        { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z', linkedFolders: [] },
        { path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z', linkedFolders: [] },
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
    workspaces: [{ path: '/configured', name: 'Configured', addedAt: '1970-01-01T00:00:00.000Z', linkedFolders: [] }],
    activeWorkspace: null,
    removedConversations: 0,
  });
  assert.deepEqual(harness.calls, [
    ['merge', { activeWorkspace: '/other' }],
    ['chat-workspace', '/other'],
    ['skill-workspace', '/other'],
    ['merge', {
      workspaces: [{ path: '/configured', name: 'Configured', addedAt: '1970-01-01T00:00:00.000Z', linkedFolders: [] }],
      activeWorkspace: null,
    }],
    ['delete-conversations', '/other'],
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
      path: '/code',
      name: 'Knowledge',
      addedAt: '2026-01-01T00:00:00.000Z',
      linkedFolders: [{ path: '/configured', name: 'configured' }],
    },
  });
  assert.equal(harness.state.activeWorkspace, '/code');
});

test('returns project metadata with basename fallback', () => {
  const indexed = { name: 'Indexed', absolutePath: '/indexed' };
  const { service } = createHarness({ projectIndex: { '/indexed': [indexed] } });

  assert.equal(service.getWorkspaceInfo(null), null);
  assert.equal(service.getWorkspaceInfo('/indexed'), indexed);
  assert.deepEqual(service.getWorkspaceInfo('/fallback'), {
    name: 'fallback',
    absolutePath: '/fallback',
  });
});
