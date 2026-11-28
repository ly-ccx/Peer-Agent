import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultWorkspaceSelection, describeWorkspaceInstallError, marketplaceInstallLabel,
  skillWorkspacePathKey, workspaceSelectionLabel,
} from './marketplace-workspace-target.ts';

const targets = [
  { id: 'missing', workspaceId: 'missing', name: 'Missing', path: '/missing', available: false, kind: 'bot', isActive: false },
  { id: 'silly', workspaceId: 'silly', name: 'SillyTavern', path: '/silly', available: true, kind: 'workspace', isActive: false },
  { id: 'peer', workspaceId: 'peer', name: 'peer-dev', path: '/peer', available: true, kind: 'bot', isActive: true },
] as const;

test('selects the current available Bot or falls back to the first available target', () => {
  assert.deepEqual(defaultWorkspaceSelection(targets), ['peer']);
  assert.deepEqual(defaultWorkspaceSelection(targets.slice(0, 2)), ['silly']);
  assert.deepEqual(defaultWorkspaceSelection([{ ...targets[0], isActive: true }, targets[1]]), ['silly']);
  assert.deepEqual(defaultWorkspaceSelection([targets[0]]), []);
  assert.deepEqual(defaultWorkspaceSelection([]), []);
});

test('picker and both market buttons use compact count-sensitive labels', () => {
  assert.equal(workspaceSelectionLabel([]), '请选择机器人');
  assert.equal(workspaceSelectionLabel(['peer-dev']), 'peer-dev');
  assert.equal(workspaceSelectionLabel(['peer-dev', 'SillyTavern']), '已选 2 个机器人');
  for (const verb of ['验证并安装', '下载并安装']) {
    assert.equal(marketplaceInstallLabel(verb, 'global', 2), `${verb}到全局`);
    assert.equal(marketplaceInstallLabel(verb, 'workspace', 1), `${verb}到机器人`);
    assert.equal(marketplaceInstallLabel(verb, 'workspace', 2), `${verb}到 2 个机器人`);
  }
});

test('installed groups recognize canonical Windows paths from the native core', () => {
  assert.equal(skillWorkspacePathKey('\\\\?\\C:\\Users\\Peer'), skillWorkspacePathKey('c:\\users\\peer'));
  assert.equal(skillWorkspacePathKey('\\\\?\\UNC\\Peer\\Share'), skillWorkspacePathKey('\\\\peer\\SHARE'));
  assert.notEqual(skillWorkspacePathKey('/Peer'), skillWorkspacePathKey('/peer'));
});

test('invalid locations and write errors have distinct localized reasons', () => {
  assert.equal(describeWorkspaceInstallError('workspace_install_target_missing'), '工作目录不存在');
  assert.equal(describeWorkspaceInstallError('write failed', 'EACCES'), '没有目录写入权限');
});
