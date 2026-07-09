import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHookConfigPaths, loadHookConfig, mergeHookConfigs } from './hook-config.mjs';

test('mergeHookConfigs appends global hooks before workspace hooks', () => {
  const merged = mergeHookConfigs([
    {
      hooks: {
        PreToolUse: [
          { id: 'global', match: { capabilityId: '*' }, command: 'node global.mjs', timeoutMs: 100 },
        ],
      },
    },
    {
      hooks: {
        PreToolUse: [
          { id: 'workspace', match: { capabilityId: 'local.shell.exec' }, command: 'node workspace.mjs', onError: 'fail-open' },
        ],
        PostToolUse: [
          { command: 'node audit.mjs' },
        ],
      },
    },
  ]);

  assert.deepEqual(merged.hooks.PreToolUse.map((hook) => hook.id), ['global', 'workspace']);
  assert.equal(merged.hooks.PreToolUse[0].onError, 'fail-closed');
  assert.equal(merged.hooks.PreToolUse[1].onError, 'fail-open');
  assert.equal(merged.hooks.PostToolUse[0].id, 'node audit.mjs');
  assert.deepEqual(merged.hooks.PostToolUse[0].match, { capabilityId: '*' });
});

test('loadHookConfig reads global and workspace hooks.json files', () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-hook-config-'));
  const userDataPath = join(root, 'user-data');
  const workspaceRoot = join(root, 'workspace');
  const { globalPath, workspacePath } = getHookConfigPaths({ userDataPath, workspaceRoot });
  mkdirSync(join(userDataPath, 'hooks'), { recursive: true });
  mkdirSync(join(workspaceRoot, '.peer'), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { id: 'global', command: 'node global.mjs' },
      ],
    },
  }));
  writeFileSync(workspacePath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { id: 'workspace', command: 'node workspace.mjs' },
      ],
    },
  }));

  const config = loadHookConfig({ userDataPath, workspaceRoot });
  assert.deepEqual(config.hooks.PreToolUse.map((hook) => hook.id), ['global', 'workspace']);
});
