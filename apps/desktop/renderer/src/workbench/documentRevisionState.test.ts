import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedDocumentRevision, documentFileLabel, documentRevisionKey, nestedDocumentReference, normalizeDocumentRevision } from './documentRevisionState.ts';

const commit = 'a'.repeat(40), repositoryId = `sha256:${'b'.repeat(64)}`;
test('only complete immutable commits restore; malformed repository bindings never become live', () => {
  for (const raw of [null, { kind: 'git', commit: 'main' }, { kind: 'git', commit: 'a'.repeat(8) }, { kind: 'git', commit: [commit] }, { kind: 'git', commit, repositoryId: '/repo' }]) {
    assert.equal(normalizeDocumentRevision(raw), undefined); assert.equal(documentRevisionKey(raw), 'invalid');
  }
  assert.equal(documentRevisionKey(undefined), 'live');
  assert.equal(normalizeDocumentRevision({ kind: 'git', commit: commit.toUpperCase() })?.commit, commit);
  assert.equal(confirmedDocumentRevision({ kind: 'git', commit, repositoryId, path: '../private.md' }), undefined);
});

test('historical local links retain commit, repository and task without inheriting content conditions', () => {
  const task = { sessionId: 'session', planId: 'plan' };
  const reference = nestedDocumentReference({ workspaceId: 'bot', path: '/repo/deleted.md', task,
    expectedObservation: { resourceId: 'not-a-child-resource' } }, 'nested.md#L4', '/repo/deleted.md', { kind: 'git', commit, repositoryId, path: 'deleted.md' });
  assert.deepEqual(reference, { workspaceId: 'bot', path: 'nested.md#L4', task, relativeTo: '/repo/deleted.md', revision: { kind: 'git', commit, repositoryId } });
  assert.notEqual(documentFileLabel('doc.md'), documentFileLabel('doc.md', reference.revision));
  assert.ok(documentFileLabel('doc.md', reference.revision).includes(commit.slice(0, 8)));
});
