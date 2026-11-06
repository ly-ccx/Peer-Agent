import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { documentIdentity, observeDocumentRead } from './document-observation.mjs';

test('identical remote names do not merge worktrees, Bot scopes or task ownership', () => {
  const reference = { workspaceId: 'bot', path: 'report.md' };
  const first = documentIdentity(reference, { root: '/worktree/a', target: '/worktree/a/report.md' });
  assert.equal(first.relativePath, 'report.md');
  assert.notEqual(first.sourceId, documentIdentity(reference, { root: '/worktree/b', target: '/worktree/b/report.md' }).sourceId);
  assert.notEqual(first.resourceId, documentIdentity({ ...reference, workspaceId: 'other' }, { root: '/worktree/a', target: '/worktree/a/report.md' }).resourceId);
  assert.notEqual(first.sourceId, documentIdentity({ ...reference, task: { sessionId: 's', planId: 'p' } }, { root: '/worktree/a', target: '/worktree/a/report.md' }).sourceId);
  const bytes = Buffer.from('真实内容\n');
  const observed = observeDocumentRead(reference, { root: '/worktree/a', target: '/worktree/a/report.md' }, bytes);
  assert.equal(observed.observation.contentVersion, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
});
