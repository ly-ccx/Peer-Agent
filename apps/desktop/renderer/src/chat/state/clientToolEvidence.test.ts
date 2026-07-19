import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientToolCall, ClientToolResult } from '@peer-agent/protocol';
import {
  createDeniedClientToolResult,
  createFailedClientToolResult,
  markClientToolResultReturnedToCloud,
} from './clientToolEvidence.ts';

const baseCall: ClientToolCall = {
  toolCallId: 'tool_call_1',
  capabilityId: 'local.shell.exec',
  displayName: 'Local Health',
  reason: 'verify local proxy',
  argumentsPreview: {},
  riskLevel: 'L0_inert',
  dataLevel: 'D0_public',
  requestedAt: '2026-05-14T00:00:00.000Z',
};

const baseResult: ClientToolResult = {
  toolCallId: baseCall.toolCallId,
  status: 'success',
  outputPreview: {
    ok: true,
  },
  evidence: {
    evidenceId: 'evidence_1',
    toolCallId: 'tool_call_1',
    summary: 'local health check passed',
    locale: 'zh-CN',
    returnedToCloud: false,
    dataLevel: 'D0_public',
    redactions: [],
    artifactRefs: [],
  },
  completedAt: '2026-05-14T00:00:00.000Z',
};

test('markClientToolResultReturnedToCloud marks the outbound cloud payload evidence', () => {
  const outbound = markClientToolResultReturnedToCloud(baseResult);

  assert.equal(outbound.evidence.returnedToCloud, true);
  assert.equal(baseResult.evidence.returnedToCloud, false);
  assert.deepEqual(outbound.outputPreview, baseResult.outputPreview);
});

test('markClientToolResultReturnedToCloud preserves already-returned results', () => {
  const returned = {
    ...baseResult,
    evidence: {
      ...baseResult.evidence,
      returnedToCloud: true,
    },
  };

  assert.equal(markClientToolResultReturnedToCloud(returned), returned);
});

test('createFailedClientToolResult records local adapter failures as evidence', () => {
  const result = createFailedClientToolResult({
    call: baseCall,
    locale: 'en-US',
    message: 'adapter crashed',
    completedAt: '2026-05-14T00:00:01.000Z',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.toolCallId, baseCall.toolCallId);
  assert.equal(result.outputPreview.capabilityId, 'local.shell.exec');
  assert.equal(result.evidence.returnedToCloud, false);
  assert.match(result.evidence.summary, /adapter crashed/);
});

test('createDeniedClientToolResult records local user denial as evidence', () => {
  const result = createDeniedClientToolResult({
    call: baseCall,
    locale: 'zh-CN',
    completedAt: '2026-05-14T00:00:02.000Z',
  });

  assert.equal(result.status, 'denied');
  assert.equal(result.outputPreview.status, 'client_denied_by_user');
  assert.equal(result.evidence.returnedToCloud, false);
  assert.match(result.evidence.summary, /拒绝/);
});
