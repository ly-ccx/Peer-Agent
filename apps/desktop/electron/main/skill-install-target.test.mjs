import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { validateSkillInstallTarget } from './skill-install-target.mjs';

const workspaces = [
  { path: '/Users/demo/alpha', name: 'Alpha' },
  { path: '/Users/demo/beta', name: 'Beta' },
];

test('global install ignores renderer-provided workspace paths', () => {
  assert.deepEqual(
    validateSkillInstallTarget({ scope: 'global', workspacePath: '/tmp/untrusted', skillId: 'demo' }, workspaces),
    { scope: 'global', workspacePath: undefined, skillId: 'demo' },
  );
});

test('workspace install accepts and canonicalizes a registered target', () => {
  assert.deepEqual(
    validateSkillInstallTarget({ scope: 'workspace', workspacePath: path.join('/Users/demo/alpha', '.'), skillId: 'demo' }, workspaces),
    { scope: 'workspace', workspacePath: '/Users/demo/alpha', skillId: 'demo' },
  );
});

test('workspace install rejects missing and unregistered targets', () => {
  assert.throws(
    () => validateSkillInstallTarget({ scope: 'workspace', skillId: 'demo' }, workspaces),
    /workspace_install_target_required/,
  );
  assert.throws(
    () => validateSkillInstallTarget({ scope: 'workspace', workspacePath: '/tmp/untrusted', skillId: 'demo' }, workspaces),
    /workspace_install_target_not_registered/,
  );
});
