import assert from 'node:assert/strict';
import test from 'node:test';
import { getMarketplaceWorkspaceTarget, getMarketplaceWorkspaceTargets } from './marketplace-workspace-target.ts';

const MARKETS = ['SkillHub', 'Qoder'] as const;
const directory = {
  activeWorkspace: '/Users/demo/projects/peer-agent/',
  workspaces: [
    { path: '/Users/demo/projects/other', name: 'Other' },
    { path: '/Users/demo/projects/peer-agent', name: 'Peer Agent' },
  ],
};

for (const market of MARKETS) {
  test(`${market}: defaults to the registered active workspace`, () => {
    const target = getMarketplaceWorkspaceTarget(directory);
    assert.deepEqual(target, {
      name: 'Peer Agent',
      path: '/Users/demo/projects/peer-agent',
      optionLabel: 'Peer Agent（当前）',
      installPath: '/Users/demo/projects/peer-agent/skills/',
      isActive: true,
    });
  });

  test(`${market}: selects another registered workspace without changing active state`, () => {
    const target = getMarketplaceWorkspaceTarget(directory, '/Users/demo/projects/other');
    assert.equal(target?.name, 'Other');
    assert.equal(target?.path, '/Users/demo/projects/other');
    assert.equal(target?.isActive, false);
    assert.equal(target?.optionLabel, 'Other');
  });

  test(`${market}: reports no target when no workspaces are registered`, () => {
    assert.equal(getMarketplaceWorkspaceTarget({ activeWorkspace: null, workspaces: [] }), null);
  });
}

test('lists every registered workspace and marks only the active one', () => {
  const targets = getMarketplaceWorkspaceTargets(directory);
  assert.deepEqual(targets.map(({ name, isActive }) => ({ name, isActive })), [
    { name: 'Other', isActive: false },
    { name: 'Peer Agent', isActive: true },
  ]);
});

test('falls back to a cross-platform path basename for an unnamed workspace', () => {
  const target = getMarketplaceWorkspaceTarget({
    activeWorkspace: 'C:\\projects\\peer-agent',
    workspaces: [{ path: 'C:\\projects\\peer-agent', name: '' }],
  });
  assert.equal(target?.optionLabel, 'peer-agent（当前）');
  assert.equal(target?.installPath, 'C:/projects/peer-agent/skills/');
});
