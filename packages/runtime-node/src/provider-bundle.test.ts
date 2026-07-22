import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RuntimeSdkEvent, RuntimeSdkHookRunner } from '@peer-agent/runtime-sdk';

import type { NodeRuntimePermissionPrompt } from './contracts.ts';
import { createNodeProviderBundle } from './provider-bundle.ts';

function fixedClock() {
  let id = 0;
  return {
    now: () => '2026-07-10T00:00:00.000Z',
    idFactory: () => `node-id-${++id}`,
  };
}

test('node provider bundle exposes a host-neutral projection and governed runtime', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-bundle-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await writeFile(path.join(workspaceRoot, 'note.txt'), 'bundle', 'utf8');
  const bundle = createNodeProviderBundle({ workspaceRoot, ...fixedClock() });

  assert.deepEqual(
    bundle.projection.tools.map(({ name, capabilityId }) => ({ name, capabilityId })),
    [
      { name: 'local_file_read', capabilityId: 'local.file.read' },
      { name: 'local_file_list', capabilityId: 'local.file.list' },
      { name: 'local_file_write', capabilityId: 'local.file.write' },
      { name: 'local_shell_exec', capabilityId: 'local.shell.exec' },
      { name: 'request_user_input', capabilityId: 'local.interaction.request_user_input' },
    ],
  );
  assert.equal(bundle.providers.length, 3);

  const execution = await bundle.runtime.execute({
    sessionId: 'session-1',
    projectionId: bundle.projection.createdAt,
    call: {
      toolCallId: 'tool-read',
      capabilityId: 'local.file.read',
      arguments: { path: 'note.txt' },
    },
  });
  assert.equal(execution.result.status, 'completed');
  assert.equal((execution.result.output as { content?: string }).content, 'bundle');
  assert.ok(execution.result.evidence);

  const blocked = await bundle.runtime.execute({
    sessionId: 'session-1',
    call: {
      toolCallId: 'tool-unprojected-direct',
      capabilityId: 'local.file.secret',
      arguments: {},
    },
  });
  assert.equal(blocked.result.status, 'denied');
  assert.equal(
    (blocked.result.error as { code?: string }).code,
    'capability_not_projected',
  );
});

test('node provider bundle materializes mode scopes into read-only plan and explorer projections', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-mode-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));

  const plan = createNodeProviderBundle({ workspaceRoot, mode: 'plan', ...fixedClock() });
  const explorer = createNodeProviderBundle({ workspaceRoot, mode: 'explorer', ...fixedClock() });
  const goal = createNodeProviderBundle({ workspaceRoot, mode: 'goal', ...fixedClock() });
  const compact = createNodeProviderBundle({ workspaceRoot, mode: 'compact', ...fixedClock() });
  const system = createNodeProviderBundle({ workspaceRoot, mode: 'system', ...fixedClock() });

  assert.deepEqual(
    plan.projection.tools.map((tool) => tool.capabilityId),
    ['local.file.read', 'local.file.list', 'local.interaction.request_user_input'],
  );
  assert.deepEqual(
    explorer.projection.tools.map((tool) => tool.capabilityId),
    ['local.file.read', 'local.file.list', 'local.interaction.request_user_input'],
  );
  const fullCapabilities = [
    'local.file.read',
    'local.file.list',
    'local.file.write',
    'local.shell.exec',
    'local.interaction.request_user_input',
  ];
  assert.deepEqual(goal.projection.tools.map((tool) => tool.capabilityId), fullCapabilities);
  assert.deepEqual(compact.projection.tools.map((tool) => tool.capabilityId), fullCapabilities);
  assert.deepEqual(system.projection.tools.map((tool) => tool.capabilityId), fullCapabilities);
});

test('pipeline tool executor resolves only projected names and blocks unprojected calls', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-projection-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await writeFile(path.join(workspaceRoot, 'note.txt'), 'projected', 'utf8');
  const bundle = createNodeProviderBundle({ workspaceRoot, ...fixedClock() });
  const context = {
    run: { sessionId: 'session-1', input: null },
    turn: 1,
    index: 0,
    emit: () => null,
  };

  const projected = await bundle.pipelineToolExecutor.execute({
    toolCallId: 'tool-projected',
    name: 'local_file_read',
    arguments: { path: 'note.txt' },
  }, context);
  assert.equal(projected.result.result.status, 'completed');

  const blocked = await bundle.pipelineToolExecutor.execute({
    toolCallId: 'tool-unprojected',
    capabilityId: 'local.file.secret',
    arguments: {},
  }, context);
  assert.equal(blocked.result.result.status, 'denied');
  assert.equal(
    (blocked.result.result.error as { code?: string }).code,
    'capability_not_projected',
  );
});

test('Hook ask and capability approval remain separate gates and preserve Hook Evidence', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-gates-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const prompts: NodeRuntimePermissionPrompt[] = [];
  const events: RuntimeSdkEvent[] = [];
  const hookRunner: RuntimeSdkHookRunner = {
    runPreToolUse() {
      return [{ hookId: 'test-pre', decision: 'ask', reason: 'review_write' }];
    },
    runPostToolUse() {
      return [{ hookId: 'test-post', decision: 'allow', reason: 'recorded' }];
    },
  };
  const bundle = createNodeProviderBundle({
    workspaceRoot,
    hookRunner,
    requestPermission(prompt) {
      prompts.push(prompt);
      return { granted: true, reason: 'approved_for_test' };
    },
    ...fixedClock(),
  });
  bundle.events.subscribe((event) => events.push(event));

  const execution = await bundle.runtime.execute({
    sessionId: 'session-1',
    call: {
      toolCallId: 'tool-write',
      capabilityId: 'local.file.write',
      arguments: { path: 'approved.txt', content: 'governed' },
    },
  });

  assert.equal(execution.result.status, 'completed');
  assert.equal(await readFile(path.join(workspaceRoot, 'approved.txt'), 'utf8'), 'governed');
  assert.deepEqual(prompts.map((prompt) => prompt.confirmation.kind), [
    'hook-approval',
    'capability-approval',
  ]);
  assert.equal(
    (execution.result.permissionGrant as { decision?: string } | undefined)?.decision,
    'allow',
  );
  const evidence = execution.result.evidence as {
    hookFinalDecision?: string;
    hooks?: readonly { id?: string }[];
  };
  assert.equal(evidence.hookFinalDecision, 'ask');
  assert.deepEqual(evidence.hooks?.map((record) => record.id), ['test-pre', 'test-post']);
  assert.deepEqual(
    events.filter((event) => event.type === 'permission.requested' || event.type === 'permission.resolved')
      .map((event) => event.type),
    ['permission.requested', 'permission.resolved'],
  );
});

test('Hook deny prevents capability approval and provider execution', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-hook-deny-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  let permissionCalls = 0;
  const bundle = createNodeProviderBundle({
    workspaceRoot,
    hookRunner: {
      runPreToolUse: () => [{ hookId: 'deny-hook', decision: 'deny', reason: 'blocked_by_hook' }],
    },
    requestPermission() {
      permissionCalls += 1;
      return { granted: true };
    },
    ...fixedClock(),
  });

  const execution = await bundle.runtime.execute({
    sessionId: 'session-1',
    call: {
      toolCallId: 'tool-denied',
      capabilityId: 'local.file.write',
      arguments: { path: 'blocked.txt', content: 'blocked' },
    },
  });
  assert.equal(execution.result.status, 'denied');
  assert.equal(permissionCalls, 0);
  await assert.rejects(readFile(path.join(workspaceRoot, 'blocked.txt'), 'utf8'));
  assert.equal(
    (execution.result.evidence as { hookFinalDecision?: string }).hookFinalDecision,
    'deny',
  );
});
