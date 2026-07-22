import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CapabilityExecutionContext, CapabilityRequest } from '@peer-agent/runtime-core';

import { createNodeFileProvider } from './file-provider.ts';
import type { NodeCapabilityPermissionPrompt } from './provider-contracts.ts';

function request(capabilityId: string, input: Record<string, unknown>): CapabilityRequest {
  return {
    capabilityId,
    toolCall: {
      toolCallId: `call-${capabilityId}`,
      capabilityId,
      input,
    },
    input,
  };
}

function context(signal?: AbortSignal): CapabilityExecutionContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    workspace: { root: '/workspace' },
    signal,
  };
}

test('file provider reads and lists workspace files with Evidence', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-file-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await mkdir(path.join(workspaceRoot, 'docs'));
  await writeFile(path.join(workspaceRoot, 'docs', 'note.txt'), 'hello node bundle', 'utf8');
  const provider = createNodeFileProvider({ workspaceRoot });

  const readResult = await provider.execute(
    request('local.file.read', { path: 'docs/note.txt' }),
    context(),
  );
  assert.equal(readResult.status, 'completed');
  assert.deepEqual(readResult.output, {
    path: 'docs/note.txt',
    content: 'hello node bundle',
    bytes: 17,
    contentHash: '0d3ca04056bfea5afaa32985710ffbbc9b60c00708be51eddc68dd58f4ba5dc3',
  });
  assert.equal(readResult.permissionGrant?.decision, 'allow');
  assert.equal(
    (readResult.evidence as { toolCallId?: string } | undefined)?.toolCallId,
    'call-local.file.read',
  );

  const listResult = await provider.execute(
    request('local.file.list', { path: 'docs' }),
    context(),
  );
  assert.equal(listResult.status, 'completed');
  assert.deepEqual(listResult.output, {
    path: 'docs',
    entries: [{ name: 'note.txt', path: 'docs/note.txt', type: 'file' }],
  });
  assert.ok(listResult.evidence);
});

test('file provider edits previously read files and rejects stale or ambiguous replacements', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-edit-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const filePath = path.join(workspaceRoot, 'note.txt');
  await writeFile(filePath, 'alpha beta beta', 'utf8');
  const provider = createNodeFileProvider({ workspaceRoot, requestApproval: () => ({ granted: true }) });

  const unread = await provider.execute(
    request('local.file.edit', { path: 'note.txt', old_string: 'alpha', new_string: 'omega' }), context(),
  );
  assert.equal(unread.error?.code, 'read_required');

  await provider.execute(request('local.file.read', { path: 'note.txt' }), context());
  const ambiguous = await provider.execute(
    request('local.file.edit', { path: 'note.txt', old_string: 'beta', new_string: 'gamma' }), context(),
  );
  assert.equal(ambiguous.error?.code, 'old_string_not_unique');

  const edited = await provider.execute(
    request('local.file.edit', { path: 'note.txt', old_string: 'beta', new_string: 'gamma', replace_all: true }), context(),
  );
  assert.equal(edited.status, 'completed');
  assert.equal(await readFile(filePath, 'utf8'), 'alpha gamma gamma');

  await writeFile(filePath, 'external change', 'utf8');
  const stale = await provider.execute(
    request('local.file.edit', { path: 'note.txt', old_string: 'alpha', new_string: 'omega' }), context(),
  );
  assert.equal(stale.error?.code, 'file_changed_since_read');
});

test('file provider searches file contents with case and result limits', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-search-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await mkdir(path.join(workspaceRoot, 'docs'));
  await writeFile(path.join(workspaceRoot, 'docs', 'a.txt'), 'Needle one\nneedle two', 'utf8');
  await writeFile(path.join(workspaceRoot, 'docs', 'b.txt'), 'needle three', 'utf8');
  const provider = createNodeFileProvider({ workspaceRoot });

  const limited = await provider.execute(
    request('local.file.search', { query: 'needle', path: 'docs', max_results: 2 }), context(),
  );
  assert.equal(limited.status, 'completed');
  assert.equal((limited.output as { matchCount?: number }).matchCount, 2);
  assert.equal((limited.output as { truncated?: boolean }).truncated, true);

  const sensitive = await provider.execute(
    request('local.file.search', { query: 'Needle', path: 'docs', case_sensitive: true }), context(),
  );
  assert.equal((sensitive.output as { matchCount?: number }).matchCount, 1);
});

test('file provider keeps write approval explicit and supports empty files', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-write-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const prompts: NodeCapabilityPermissionPrompt[] = [];
  let granted = false;
  const provider = createNodeFileProvider({
    workspaceRoot,
    requestApproval(prompt) {
      prompts.push(prompt);
      return granted
        ? { granted: true, reason: 'approved_for_test' }
        : { granted: false, reason: 'denied_for_test' };
    },
  });

  const denied = await provider.execute(
    request('local.file.write', { path: 'empty.txt', content: '' }),
    context(),
  );
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error?.code, 'denied_for_test');
  assert.equal(denied.permissionGrant?.decision, 'deny');
  assert.equal(prompts[0]?.confirmation.kind, 'capability-approval');
  assert.equal(prompts[0]?.confirmation.approvalKind, 'file-write');
  await assert.rejects(readFile(path.join(workspaceRoot, 'empty.txt'), 'utf8'));

  granted = true;
  const completed = await provider.execute(
    request('local.file.write', { path: 'empty.txt', content: '' }),
    context(),
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.permissionGrant?.decision, 'allow');
  assert.equal(await readFile(path.join(workspaceRoot, 'empty.txt'), 'utf8'), '');
  assert.ok(completed.evidence);
});

test('file provider allows absolute and relative paths outside the workspace root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-escape-'));
  const workspaceRoot = path.join(root, 'workspace');
  const outsideRoot = path.join(root, 'outside');
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
  await symlink(outsideRoot, path.join(workspaceRoot, 'linked-outside'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const provider = createNodeFileProvider({
    workspaceRoot,
    requestApproval: () => ({ granted: true }),
  });

  // Relative escape from workspace root.
  const lexical = await provider.execute(
    request('local.file.read', { path: '../outside/secret.txt' }),
    context(),
  );
  assert.equal(lexical.status, 'completed');
  assert.equal((lexical.output as { content?: string } | undefined)?.content, 'secret');

  // Symlink that lands outside the workspace root.
  const existingSymlink = await provider.execute(
    request('local.file.read', { path: 'linked-outside/secret.txt' }),
    context(),
  );
  assert.equal(existingSymlink.status, 'completed');
  assert.equal((existingSymlink.output as { content?: string } | undefined)?.content, 'secret');

  // Absolute path outside workspace.
  const absolute = await provider.execute(
    request('local.file.read', { path: path.join(outsideRoot, 'secret.txt') }),
    context(),
  );
  assert.equal(absolute.status, 'completed');
  assert.equal((absolute.output as { content?: string } | undefined)?.content, 'secret');

  // Write outside workspace after approval (no path hard sandbox).
  const writeOutside = await provider.execute(
    request('local.file.write', {
      path: path.join(outsideRoot, 'new.txt'),
      content: 'allowed-outside',
    }),
    context(),
  );
  assert.equal(writeOutside.status, 'completed');
  assert.equal(await readFile(path.join(outsideRoot, 'new.txt'), 'utf8'), 'allowed-outside');
});
