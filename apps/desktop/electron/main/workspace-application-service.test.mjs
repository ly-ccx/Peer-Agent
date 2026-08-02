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
    listConversations: (options) => {
      calls.push(['list-conversations', options]);
      return conversations;
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

test('lists configured and existing discovered workspaces once', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.listWorkspaces(), {
    workspaces: [
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/discovered', name: 'discovered', addedAt: '1970-01-01T00:00:00.000Z' },
    ],
    activeWorkspace: '/configured',
  });
  assert.deepEqual(calls, [['list-conversations', { includeMessageCount: false }]]);
});

test('reuses an existing active workspace without persistence or synchronization', () => {
  const { service, calls } = createHarness();

  assert.deepEqual(service.ensureDefaultWorkspace(), {
    path: '/configured',
    name: 'configured',
    created: false,
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
      { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
      { path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z' },
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
        { path: '/configured', name: 'Configured', addedAt: '2026-01-01T00:00:00.000Z' },
        { path: '/new-project', name: 'new-project', addedAt: '2026-08-01T12:00:00.000Z' },
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
    workspaces: [{ path: '/configured', name: 'Configured' }],
    activeWorkspace: null,
  });
  assert.deepEqual(harness.calls, [
    ['merge', { activeWorkspace: '/other' }],
    ['chat-workspace', '/other'],
    ['skill-workspace', '/other'],
    ['merge', {
      workspaces: [{ path: '/configured', name: 'Configured' }],
      activeWorkspace: null,
    }],
    ['skill-workspace', null],
  ]);
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
