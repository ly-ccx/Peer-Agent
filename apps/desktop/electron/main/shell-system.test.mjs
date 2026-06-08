import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalShellProvider, classifyShellCommand } from './runtime-gateway/local-shell-provider.mjs';

function toolCall(toolCallId, command, extraArguments = {}) {
  return {
    toolCallId,
    capabilityId: 'local.shell.exec',
    displayName: 'Local shell execution',
    reason: 'test shell',
    arguments: { command, ...extraArguments },
    argumentsPreview: { command, ...extraArguments },
    riskLevel: 'L4_privileged',
    dataLevel: 'D2_sensitive',
    requestedAt: new Date().toISOString(),
  };
}

test('shell classifier handles pipeline, wrapper, env prefix, and destructive commands', () => {
  const workspaceRoot = process.cwd();
  assert.equal(
    classifyShellCommand({ command: 'cat package.json | rg name', workspaceRoot }).category,
    'read-only',
  );
  const wrapped = classifyShellCommand({ command: 'FOO=1 bash -c "git status"', workspaceRoot });
  assert.equal(wrapped.category, 'read-only');
  assert.equal(wrapped.features.includes('shell_wrapper'), true);
  assert.equal(
    classifyShellCommand({ command: 'echo hello > out.txt', workspaceRoot }).category,
    'write',
  );
  assert.equal(
    classifyShellCommand({ command: 'rm -rf node_modules', workspaceRoot }).category,
    'destructive',
  );
});

test('local shell provider auto-runs read-only commands and persists output artifacts', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'shell-system-read-'));
  const provider = createLocalShellProvider({ workspaceRoot: tmpDir, userDataPath: tmpDir });
  const { grant, result } = await provider.execute(toolCall('shell-read', 'pwd'), 'zh-CN');

  assert.equal(grant.granted, true);
  assert.equal(result.status, 'success');
  assert.match(result.outputPreview.stdout, new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.evidence.artifactRefs.length, 3);
  const metadataPath = path.join(tmpDir, 'shell-artifacts', new Date().toISOString().slice(0, 10), result.outputPreview.backgroundTaskId, 'metadata.json');
  assert.equal(existsSync(metadataPath), true);
  assert.match(readFileSync(metadataPath, 'utf8'), /shell-read/);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('shell permission rule can allow an exact write command without broad shell trust', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'shell-system-rule-'));
  const provider = createLocalShellProvider({ workspaceRoot: tmpDir, userDataPath: tmpDir });
  provider.permissionReview.addShellRule({
    behavior: 'allow',
    match: { type: 'exact', command: 'echo hello > out.txt' },
    scope: { cwd: tmpDir, maxRiskLevel: 'L2_local_write' },
  });

  const { grant, result } = await provider.execute(toolCall('shell-write', 'echo hello > out.txt'), 'zh-CN');
  assert.equal(grant.granted, true);
  assert.equal(result.status, 'success');
  assert.equal(readFileSync(path.join(tmpDir, 'out.txt'), 'utf8').trim(), 'hello');

  rmSync(tmpDir, { recursive: true, force: true });
});

test('background shell tasks can be stopped through the task manager', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'shell-system-background-'));
  const provider = createLocalShellProvider({ workspaceRoot: tmpDir, userDataPath: tmpDir });
  provider.permissionReview.addShellRule({
    behavior: 'allow',
    match: { type: 'prefix', prefix: 'node -e' },
    scope: { cwd: tmpDir, maxRiskLevel: 'L4_privileged' },
  });

  const started = await provider.execute(
    toolCall('shell-bg', 'node -e "setTimeout(() => {}, 5000)"', { runInBackground: true, timeoutMs: 10000 }),
    'zh-CN',
  );
  assert.equal(started.grant.granted, true);
  assert.equal(started.result.outputPreview.status, 'running');
  assert.match(started.result.outputPreview.backgroundTaskId, /^shell_/);

  const stopResult = provider.stopActiveTask();
  assert.equal(stopResult.stopped, true);
  assert.equal(stopResult.taskId, started.result.outputPreview.backgroundTaskId);
  await new Promise((resolve) => setTimeout(resolve, 80));

  rmSync(tmpDir, { recursive: true, force: true });
});

test('permission review rejects overbroad shell allow rules', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'shell-system-rule-deny-'));
  const provider = createLocalShellProvider({ workspaceRoot: tmpDir, userDataPath: tmpDir });

  assert.throws(() => provider.permissionReview.addShellRule({
    behavior: 'allow',
    match: { type: 'wildcard', pattern: '*' },
    scope: { cwd: tmpDir, maxRiskLevel: 'L4_privileged' },
  }), /allow rules cannot use wildcard/);

  assert.throws(() => provider.permissionReview.addShellRule({
    behavior: 'allow',
    match: { type: 'exact', command: 'touch file.txt' },
    scope: { cwd: path.dirname(tmpDir), maxRiskLevel: 'L2_local_write' },
  }), /cwd_outside_workspace|workspace/);

  assert.throws(() => provider.permissionReview.addShellRule({
    behavior: 'allow',
    match: { type: 'exact', command: 'touch file.txt' },
    scope: { cwd: tmpDir, maxRiskLevel: 'L5_destructive' },
  }), /destructive/);

  rmSync(tmpDir, { recursive: true, force: true });
});
