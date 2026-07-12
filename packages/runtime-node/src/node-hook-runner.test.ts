import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createNodeHookRunner,
  matchesNodeHook,
  mostRestrictiveNodeHookDecision,
} from './node-hook-runner.ts';
import {
  getNodeHookConfigPaths,
  loadNodeHookConfig,
  mergeNodeHookConfigs,
} from './node-hook-config.ts';

const payload = {
  sessionId: 'session-1',
  call: {
    toolCallId: 'call-1',
    capabilityId: 'local.shell.exec',
    arguments: { command: 'rm -rf /tmp/x' },
  },
};

test('matches capability and argument glob patterns', () => {
  assert.equal(matchesNodeHook({ command: 'x', match: { capabilityId: 'local.shell.*', argumentsPattern: 'rm -rf*' } }, payload), true);
  assert.equal(matchesNodeHook({ command: 'x', match: { capabilityId: 'local.file.*' } }, payload), false);
});

test('runs matching hooks and parses decisions', async () => {
  const runner = createNodeHookRunner({
    hooks: {
      PreToolUse: [{ id: 'deny-rm', command: `node -e "process.stdin.resume(); process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked'}))"` }],
    },
  });
  const records = await runner.runPreToolUse!(payload);
  assert.equal(records[0]?.decision, 'deny');
  assert.equal(records[0]?.reason, 'blocked');
});

test('times out pre hooks fail closed while fail-open hooks allow', async () => {
  const closed = createNodeHookRunner({ hooks: { PreToolUse: [{ command: `node -e "setTimeout(()=>{}, 1000)"`, timeoutMs: 20 }] } });
  const open = createNodeHookRunner({ hooks: { PreToolUse: [{ command: `node -e "setTimeout(()=>{}, 1000)"`, timeoutMs: 20, onFailure: 'open' }] } });
  assert.equal((await closed.runPreToolUse!(payload))[0]?.decision, 'deny');
  assert.equal((await open.runPreToolUse!(payload))[0]?.decision, 'allow');
});

test('non-zero pre hooks fail closed and post hooks remain audit-only', async () => {
  const runner = createNodeHookRunner({
    hooks: {
      PreToolUse: [{ command: 'node -e "process.exit(7)"' }],
      PostToolUse: [{ command: 'node -e "process.exit(7)"' }],
    },
  });
  assert.equal((await runner.runPreToolUse!(payload))[0]?.decision, 'deny');
  assert.equal((await runner.runPostToolUse!(payload))[0]?.decision, 'allow');
});

test('merges global hooks before workspace hooks and discovers standard paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-node-hooks-'));
  const userDataPath = join(root, 'user');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(userDataPath, 'hooks'), { recursive: true });
  mkdirSync(join(workspaceRoot, '.peer'), { recursive: true });
  writeFileSync(join(userDataPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ id: 'global', command: 'x' }] } }));
  writeFileSync(join(workspaceRoot, '.peer', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ id: 'workspace', command: 'y' }] } }));

  assert.deepEqual(getNodeHookConfigPaths({ userDataPath, workspaceRoot }), {
    globalPath: join(userDataPath, 'hooks', 'hooks.json'),
    workspacePath: join(workspaceRoot, '.peer', 'hooks.json'),
  });
  assert.deepEqual(loadNodeHookConfig({ userDataPath, workspaceRoot }).hooks.PreToolUse?.map((hook) => hook.id), ['global', 'workspace']);
  assert.deepEqual(mergeNodeHookConfigs([null, { hooks: { PostToolUse: [{ command: 'z' }] } }]).hooks.PostToolUse?.length, 1);
});

test('uses deny before ask before allow', () => {
  assert.equal(mostRestrictiveNodeHookDecision([{ decision: 'allow' }, { decision: 'ask' }]), 'ask');
  assert.equal(mostRestrictiveNodeHookDecision([{ decision: 'ask' }, { decision: 'deny' }]), 'deny');
});
