import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResourceEditExecutionRecord, normalizeResourceEditPostlude, resourceEditExecutionMatches, resourceEditExecutionReceipt } from './resource-edit-execution.ts';
import { normalizeResourceEditTarget, type ResourceEditOperation } from './resource-edit.ts';
import { RESOURCE_FILE_REPLACE_CAPABILITY as capabilityId, RESOURCE_FILE_REPLACE_PROVIDER as providerId, RESOURCE_FILE_REPLACE_TOOL as toolName } from './resource-file-replace.ts';
const version = 'sha256:' + 'a'.repeat(64), proposal = 'sha256:' + 'b'.repeat(64), time = '2026-10-27T03:00:00Z', id = 'resource-edit:request';
const target = normalizeResourceEditTarget({ recipient: { workspaceId: 'bot', conversationId: 'main' }, reference: { workspaceId: 'bot', path: '/repo/a.md' }, base: { resourceId: version, contentVersion: version } })!;
const operation: ResourceEditOperation = { requestId: 'request', draftId: 'draft', draftRevision: 1, target, providerId, proposedVersion: proposal, payloadHash: version, phase: 'running', hostEpoch: 'host', createdAt: time, updatedAt: time };
const raw = { schemaVersion: 1, workspaceId: 'bot', requestId: 'request', payloadHash: version, projectionId: 'resource-edit:request', sessionId: 'main',
  call: { toolCallId: id, capabilityId, toolName, argumentsDigest: version, occurredAt: time },
  grant: { grantId: 'actual-grant', toolCallId: id, granted: true, duration: 'once', scope: capabilityId, decidedAt: time },
  result: { toolCallId: id, status: 'success', completedAt: time, observation: { kind: 'resource_file_replace_result', requestId: 'request', path: '/repo/a.md', resourceId: version, expectedVersion: version, proposedVersion: proposal, observedVersion: proposal, status: 'success', outcome: 'applied', effectStarted: true },
    evidence: { evidenceId: 'evidence', toolCallId: id, summary: 'Actual result.', locale: 'en-US', returnedToCloud: false, dataLevel: 'D2_sensitive', redactions: [], artifactRefs: [] } } };
test('only one coherent actual call/grant/result/evidence tuple can become an applied receipt', () => {
  const record = normalizeResourceEditExecutionRecord(raw)!; assert.ok(record); assert.equal(resourceEditExecutionMatches(record, operation), true);
  assert.equal(resourceEditExecutionReceipt(record, operation)?.outcome, 'applied');
  for (const changed of [{ ...raw, call: { ...raw.call, toolCallId: 'other' } }, { ...raw, grant: { ...raw.grant, granted: false, duration: 'denied' } },
    { ...raw, result: { ...raw.result, evidence: { ...raw.result.evidence, toolCallId: 'other' } } }, { ...raw, writer: { token: 'secret' } }, { ...raw, call: { ...raw.call, arguments: { content: 'secret body' } } }]) assert.equal(normalizeResourceEditExecutionRecord(changed), undefined);
  assert.equal(resourceEditExecutionReceipt(record, { ...operation, payloadHash: proposal }), undefined);
  assert.equal(resourceEditExecutionReceipt({ ...record, sessionId: 'other-session' }, operation), undefined);
});
test('partial-write observations remain uncertainty; unknown current bytes cannot supply a success receipt', () => {
  const record = normalizeResourceEditExecutionRecord({ ...raw, result: { ...raw.result, status: 'failed', observation: { ...raw.result.observation, outcome: 'uncertain', status: 'failed', observedVersion: undefined } } })!;
  assert.ok(record); assert.equal(resourceEditExecutionReceipt(record, operation), undefined);
  assert.equal(normalizeResourceEditExecutionRecord({ ...raw, result: { ...raw.result, evidence: undefined } }), undefined);
});
test('postlude is bounded, separate from execution truth, and cannot carry replacement grants or fake completion', () => {
  const value = { schemaVersion: 1, requestId: 'request', payloadHash: version, completedAt: time, status: 'unconfirmed', reason: 'post_hook_failed' };
  assert.ok(normalizeResourceEditPostlude(value)); assert.equal(normalizeResourceEditPostlude({ ...value, reason: undefined }), undefined);
  assert.equal(normalizeResourceEditPostlude({ ...value, grant: { granted: true } }), undefined);
  assert.equal(normalizeResourceEditPostlude({ ...value, reason: 'x'.repeat(20000) }), undefined);
  assert.ok(normalizeResourceEditPostlude({ ...value, status: 'recorded', hooks: [{ id: 'hook', event: 'PostToolUse', decision: 'allow', durationMs: 3 }] }));
});
test('only the exact original permission prefix can be retained; earlier Provider records normalize that existing association', () => {
  const permissionCallId = `chat-permission:${id}`;
  const legacy = normalizeResourceEditExecutionRecord({ ...raw, result: { ...raw.result, observation: { ...raw.result.observation, permissionCallId } } });
  assert.equal(legacy?.call.permissionCallId, permissionCallId);
  assert.equal(normalizeResourceEditExecutionRecord({ ...raw, call: { ...raw.call, permissionCallId: 'chat-permission:someone-else' } }), undefined);
  assert.equal(normalizeResourceEditExecutionRecord({ ...raw, result: { ...raw.result, observation: { ...raw.result.observation, permissionCallId: 'chat-permission:someone-else' } } }), undefined);
});
test('negative scope-less legacy policy/timeout Grants remain negative facts and can never be normalized as applied', () => {
  for (const scope of [null, undefined]) {
    const value = { ...raw, grant: { ...raw.grant, granted: false, duration: 'denied', scope }, result: { ...raw.result, status: 'denied', observation: undefined, blockedReason: 'permission_timeout' } };
    const denied = normalizeResourceEditExecutionRecord(value); assert.ok(denied); assert.equal(denied.grant.scope, scope); assert.equal(resourceEditExecutionReceipt(denied, operation)?.outcome, 'denied');
    assert.equal(normalizeResourceEditExecutionRecord({ ...raw, grant: { ...raw.grant, scope } }), undefined);
  }
});
