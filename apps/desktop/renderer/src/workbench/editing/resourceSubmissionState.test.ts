import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResourceEditTarget, RESOURCE_FILE_REPLACE_PROVIDER, type ResourceEditOperation, type ResourceEditOperationStatus } from '@peer-agent/protocol';
import type { ResourceEditSessionState } from './resourceEditSession.ts';
import { submissionReadiness, submissionStatus } from './resourceSubmissionState.ts';
const base = 'sha256:' + 'a'.repeat(64), proposal = 'sha256:' + 'b'.repeat(64), time = '2026-10-27T01:00:00Z';
const target = normalizeResourceEditTarget({ recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/fixture/a.md' }, base: { resourceId: base, contentVersion: base } })!;
const draft = { id: 'draft', target, baseText: 'base', text: 'proposed', revision: 1, createdAt: time, updatedAt: time }, handle = { viewId: 'view', windowId: 'window', generation: 1, draftId: 'draft' };
const state: ResourceEditSessionState = { baseline: { target, baseText: 'base' }, view: { draft, handle }, writer: { viewId: 'view', windowId: 'window', generation: 1, token: 'token', lease: 1 },
  text: 'proposed', savedText: 'proposed', dirty: false, loading: false, saving: false, composing: false, error: null, remoteChanged: false, reviewRequired: false, cursor: { start: 0, end: 0, top: 0, left: 0 }, reading: {} };
const operation: ResourceEditOperation = { requestId: 'request', draftId: 'draft', draftRevision: 1, target, providerId: RESOURCE_FILE_REPLACE_PROVIDER,
  proposedVersion: proposal, payloadHash: base, phase: 'running', hostEpoch: 'host', createdAt: time, updatedAt: time };
test('permission display requires the original target, request and a real live execution; malformed or cross-draft states cannot arm a decision', () => {
  const permission = { requestId: 'request', challengeId: 'challenge', argsDigest: base, deadlineAt: time, path: target.reference.path, expectedVersion: base, proposedVersion: proposal, reason: 'write' };
  const raw: ResourceEditOperationStatus = { operation, live: true, hasActualResult: false, governance: 'unavailable', permission };
  assert.ok(submissionStatus(raw, state, 'bot', 'draft', 'request'));
  for (const altered of [{ ...raw, live: false }, { ...raw, permission: { ...permission, path: '/other/a.md' } }, { ...raw, permission: { ...permission, proposedVersion: base } },
    { ...raw, operation: { ...operation, draftId: 'other-draft' } }]) assert.equal(submissionStatus(altered, state, 'bot', 'draft', 'request'), null);
});
test('unknown IDs and pending operations block another submit; a real applied version requires an explicitly verified or new base', () => {
  assert.equal(submissionReadiness(state, [], true, true), 'RESOURCE_EDIT_SUBMIT_UNCONFIRMED');
  assert.equal(submissionReadiness(state, [{ ...operation, phase: 'uncertain' }], true, false), 'RESOURCE_EDIT_OPERATION_PENDING');
  const applied: ResourceEditOperation = { ...operation, phase: 'settled', receipt: { outcome: 'applied', observedVersion: proposal, toolCallId: 'actual-call', evidenceRef: 'tool-result://actual-call' } };
  assert.equal(submissionReadiness(state, [applied], true, false), 'RESOURCE_EDIT_NEW_BASE_REQUIRED');
  assert.equal(submissionReadiness(state, [applied], true, false, 0, 'matches_base'), null);
  assert.equal(submissionReadiness({ ...state, composing: true }, [], true, false), 'RESOURCE_EDIT_COMPOSITION_ACTIVE');
  assert.equal(submissionReadiness({ ...state, text: state.baseline!.baseText }, [], true, false), 'RESOURCE_EDIT_NO_CHANGES');
});
