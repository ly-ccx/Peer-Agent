import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResourceWindowNavigation, normalizeResourceWindowOwner, normalizeResourceWindowRequest } from './resource-window.ts';
const reference = { workspaceId: 'bot', path: '/project/a.md', task: { sessionId: 'session', planId: 'plan' } };
const request = { resource: { kind: 'document', reference, mode: 'preview' }, sourceTabId: 'tab', navigation: { top: 250, left: 0 } };
test('only read-only resource references and bounded presentation values cross the window seam', () => {
  const value = normalizeResourceWindowRequest(request)!;
  assert.equal(value.resource.kind, 'document'); assert.deepEqual(value.resource.reference.task, reference.task);
  assert.equal(value.navigation?.top, 250); assert.notEqual(value.resource.reference, reference);
  for (const raw of [{ ...request, owner: { workspaceId: 'foreign' } }, { ...request, windowId: 'fake' }, { ...request, resource: { ...request.resource, body: 'not admitted' } },
    { resource: { kind: 'browser', reference, guestId: 5 } }, { ...request, navigation: { top: 0, left: 0, draft: 'not admitted' } },
    { ...request, resource: { ...request.resource, reference: { ...reference, permission: 'full' } } }]) assert.equal(normalizeResourceWindowRequest(raw), undefined);
});
test('invalid history, task and comparison data cannot be erased into a current/default resource', () => {
  const history = { ...reference, revision: { kind: 'git', commit: 'a'.repeat(40), repositoryId: 'repository' } };
  assert.equal(normalizeResourceWindowRequest({ resource: { ...request.resource, reference: history } })?.resource.reference.revision?.commit, 'a'.repeat(40));
  assert.equal(normalizeResourceWindowRequest({ resource: { ...request.resource, reference: history, mode: 'diff' } }), undefined);
  assert.equal(normalizeResourceWindowRequest({ resource: { ...request.resource, reference: { ...history, revision: { kind: 'git', commit: 'HEAD' } } } }), undefined);
  assert.equal(normalizeResourceWindowRequest({ resource: { ...request.resource, reference: { ...reference, task: { sessionId: '../session', planId: 'plan' } } } }), undefined);
  assert.equal(normalizeResourceWindowRequest({ resource: { kind: 'directory', reference: history } }), undefined);
  const compare = { kind: 'comparison', reference: { ...reference, kind: 'directory' }, fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) };
  assert.equal(normalizeResourceWindowRequest({ resource: compare })?.resource.kind, 'comparison');
  assert.equal(normalizeResourceWindowRequest({ resource: { ...compare, comparison: 'working' } }), undefined);
  assert.equal(normalizeResourceWindowRequest({ resource: { ...compare, fromRef: 'main' } }), undefined);
});
test('navigation is kind-specific; over-budget and non-finite hints fail rather than losing state silently', () => {
  assert.equal(normalizeResourceWindowNavigation({ top: Infinity, left: 0 }, 'document'), undefined);
  assert.equal(normalizeResourceWindowNavigation({ top: 0, left: 0, expanded: ['/a'] }, 'comparison'), undefined);
  assert.equal(normalizeResourceWindowNavigation({ top: 0, left: 0, expanded: Array(65).fill('/a') }, 'directory'), undefined);
  const nav = normalizeResourceWindowNavigation({ top: 0, left: 0, expanded: ['a', 'a'], filter: '', selected: 'a' }, 'directory');
  assert.deepEqual(nav?.expanded, ['a']);
  assert.equal(normalizeResourceWindowOwner({ workspaceId: '../bot', conversationId: 'chat' }), undefined);
  assert.equal(normalizeResourceWindowOwner({ workspaceId: 'bot', conversationId: 'chat', task: { sessionId: 's' } }), undefined);
});
test('observation and delivery references survive as hints without accepting a snapshot body', () => {
  const value = normalizeResourceWindowRequest({ ...request, resource: { ...request.resource,
    reference: { ...reference, expectedObservation: { resourceId: 'sha256:' + 'b'.repeat(64), contentVersion: 'sha256:' + 'a'.repeat(64) } },
    delivery: { evidenceRef: 'tool-result://delivery', artifactRef: 'file:///project/a.md' } } })!;
  assert.equal(value.resource.reference.expectedObservation?.contentVersion, 'sha256:' + 'a'.repeat(64));
  assert.equal(normalizeResourceWindowRequest({ ...request, resource: { ...request.resource, reference: { ...reference, expected: { sourceId: 'legacy', resourceId: 'legacy' } } } }), undefined);
  assert.equal(value.resource.kind === 'document' && value.resource.delivery?.evidenceRef, 'tool-result://delivery');
  assert.equal(normalizeResourceWindowRequest({ ...request, resource: { ...request.resource, mode: 1 } }), undefined);
});

test('a single-file Diff must carry its actual index/worktree base rather than choosing one implicitly', () => {
  assert.equal(normalizeResourceWindowRequest({ resource: { ...request.resource, mode: 'diff' } }), undefined);
  const staged = normalizeResourceWindowRequest({ resource: { ...request.resource, mode: 'diff', comparison: 'staged' } });
  assert.equal(staged?.resource.kind === 'document' && staged.resource.mode === 'diff' && staged.resource.comparison, 'staged');
});

test('reading checkpoints admit bounded per-mode/file positions and only relative directory branches', () => {
  assert.equal(normalizeResourceWindowNavigation({ top: 1, left: 0, expanded: ['../escape'] }, 'directory'), undefined);
  assert.equal(normalizeResourceWindowNavigation({ top: 1, left: 0, selected: '/absolute' }, 'directory'), undefined);
  assert.equal(normalizeResourceWindowNavigation({ top: 1, left: 0, positions: [{ key: 'source', top: 1, left: 0 }, { key: 'source', top: 2, left: 0 }] }, 'document'), undefined);
  assert.equal(normalizeResourceWindowNavigation({ top: 1, left: 0, positions: [{ key: 'foreign-mode', top: 1, left: 0 }] }, 'document'), undefined);
  const nav = normalizeResourceWindowNavigation({ top: 120, left: 0, mode: 'source', positions: [{ key: 'preview', top: 40, left: 0 }, { key: 'source', top: 120, left: 0 }] }, 'document');
  assert.equal(nav?.mode, 'source'); assert.equal(nav?.positions?.length, 2);
  assert.equal(normalizeResourceWindowNavigation({ ...nav, positions: Array.from({ length: 13 }, (_, i) => ({ key: `file:${i}`, top: 0, left: 0 })) }, 'comparison'), undefined);
});
