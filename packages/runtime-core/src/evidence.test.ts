import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendEvidenceRecords,
  appendHookEvidence,
  applyEvidenceRedactors,
  createEvidenceBundle,
  sanitizeHookEvidenceRecord,
  type EvidenceRecord,
} from './index.ts';

const baseRecord: EvidenceRecord = {
  evidenceId: 'evidence-1',
  kind: 'tool_result',
  source: 'runtime-core-test',
  createdAt: '2026-07-09T00:00:00.000Z',
  message: 'raw secret',
};

test('createEvidenceBundle normalizes portable evidence defaults', () => {
  assert.deepEqual(createEvidenceBundle({
    evidenceId: 'evidence-1',
    toolCallId: 'call-1',
    summary: 'summary',
    locale: 'en-US',
    dataLevel: 'D1_internal',
    artifactRefs: ['artifact-1'],
  }), {
    evidenceId: 'evidence-1',
    toolCallId: 'call-1',
    summary: 'summary',
    locale: 'en-US',
    returnedToCloud: false,
    dataLevel: 'D1_internal',
    redactions: [],
    artifactRefs: ['artifact-1'],
  });

  assert.deepEqual(createEvidenceBundle(), {
    evidenceId: undefined,
    toolCallId: undefined,
    summary: undefined,
    locale: undefined,
    returnedToCloud: false,
    dataLevel: 'D0_public',
    redactions: [],
    artifactRefs: [],
  });
});

test('applyEvidenceRedactors applies redactors in order without side effects', () => {
  const redacted = applyEvidenceRedactors(baseRecord, [
    (record) => ({ ...record, message: 'redacted' }),
    (record) => ({ ...record, metadata: { redacted: true } }),
  ]);

  assert.equal(baseRecord.message, 'raw secret');
  assert.deepEqual(redacted, {
    ...baseRecord,
    message: 'redacted',
    metadata: { redacted: true },
  });
});

test('appendEvidenceRecords preserves existing evidence fields and appends records refs metadata', () => {
  const result = appendEvidenceRecords(
    {
      toolCallId: 'call-1',
      evidence: {
        summary: 'existing summary',
        records: [{ ...baseRecord, evidenceId: 'existing-record' }],
        refs: ['existing-ref'],
        metadata: { provider: 'desktop' },
      },
    },
    [baseRecord],
    {
      refs: ['new-ref'],
      metadata: { stage: 'post-tool-use' },
    },
  );

  assert.equal(result.evidence.summary, 'existing summary');
  assert.deepEqual(result.evidence.records, [
    { ...baseRecord, evidenceId: 'existing-record' },
    baseRecord,
  ]);
  assert.deepEqual(result.evidence.refs, ['existing-ref', 'new-ref']);
  assert.deepEqual(result.evidence.metadata, {
    provider: 'desktop',
    stage: 'post-tool-use',
  });
});

test('appendEvidenceRecords returns the original result when there is nothing to append', () => {
  const result = { toolCallId: 'call-1', evidence: { summary: 'unchanged' } };
  assert.equal(appendEvidenceRecords(result, []), result);
});

test('sanitizeHookEvidenceRecord keeps only portable hook evidence fields', () => {
  assert.deepEqual(
    sanitizeHookEvidenceRecord({
      id: 'hook-1',
      hookId: 'legacy-hook-id',
      event: 'PreToolUse',
      decision: 'deny',
      reason: 'blocked',
      outcome: 'ok',
      durationMs: 12,
      exitCode: 0,
      command: 'should-not-leak',
    } as never),
    {
      id: 'hook-1',
      event: 'PreToolUse',
      decision: 'deny',
      reason: 'blocked',
      outcome: 'ok',
      durationMs: 12,
      exitCode: 0,
    },
  );

  assert.equal(sanitizeHookEvidenceRecord({ hookId: 'hook-2' }).id, 'hook-2');
});

test('appendHookEvidence appends hook records and uses an injected timestamp', () => {
  const result = appendHookEvidence(
    {
      toolCallId: 'call-1',
      evidence: {
        summary: 'existing summary',
        hooks: [{ id: 'existing', event: 'PreToolUse', decision: 'allow' }],
      },
    },
    [
      {
        id: 'post',
        event: 'PostToolUse',
        decision: 'ask',
        reason: 'needs approval',
        outcome: 'ok',
        durationMs: 3,
        exitCode: 0,
        rawStdout: 'should-not-leak',
      } as never,
    ],
    'ask',
    { recordedAt: '2026-07-09T00:00:01.000Z' },
  );

  const evidence = result.evidence as Record<string, unknown>;

  assert.equal(evidence.summary, 'existing summary');
  assert.deepEqual(evidence.hooks, [
    { id: 'existing', event: 'PreToolUse', decision: 'allow' },
    {
      id: 'post',
      event: 'PostToolUse',
      decision: 'ask',
      reason: 'needs approval',
      outcome: 'ok',
      durationMs: 3,
      exitCode: 0,
    },
  ]);
  assert.equal(evidence.hookFinalDecision, 'ask');
  assert.equal(evidence.hookRecordedAt, '2026-07-09T00:00:01.000Z');
});

test('appendHookEvidence keeps existing final decision when no new final decision is provided', () => {
  const result = appendHookEvidence(
    {
      toolCallId: 'call-1',
      evidence: {
        hookFinalDecision: 'deny',
      },
    },
    [{ id: 'post', event: 'PostToolUse', decision: 'allow' }],
    undefined,
    { now: () => '2026-07-09T00:00:02.000Z' },
  );

  const evidence = result.evidence as Record<string, unknown>;

  assert.equal(evidence.hookFinalDecision, 'deny');
  assert.equal(evidence.hookRecordedAt, '2026-07-09T00:00:02.000Z');
});
