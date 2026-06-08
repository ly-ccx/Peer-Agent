import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientToolCall, ClientToolResult, PermissionGrant } from '@zeus-atlas/protocol';
import { applyToolResult, type TaskThread } from './index.ts';

const call: ClientToolCall = {
  toolCallId: 'tool_call_denied',
  capabilityId: 'local.health',
  displayName: 'Local Health',
  reason: 'verify local proxy',
  argumentsPreview: {},
  riskLevel: 'L0_inert',
  dataLevel: 'D0_public',
  requestedAt: '2026-05-14T00:00:00.000Z',
};

const deniedGrant: PermissionGrant = {
  grantId: 'grant_denied',
  toolCallId: call.toolCallId,
  granted: false,
  duration: 'denied',
  scope: 'client_session',
  decidedAt: '2026-05-14T00:00:01.000Z',
};

const deniedResult: ClientToolResult = {
  toolCallId: call.toolCallId,
  status: 'denied',
  outputPreview: {
    status: 'client_denied_by_user',
    capabilityId: call.capabilityId,
  },
  evidence: {
    evidenceId: 'evidence_denied',
    toolCallId: call.toolCallId,
    summary: 'The user denied local capability local.health.',
    locale: 'en-US',
    returnedToCloud: true,
    dataLevel: call.dataLevel,
    redactions: [],
    artifactRefs: [],
  },
  completedAt: '2026-05-14T00:00:02.000Z',
};

test('applyToolResult attaches denied results and creates stable evidence artifact ids', () => {
  const thread: TaskThread = {
    threadId: 'thread_1',
    title: 'Local proxy review',
    events: [
      {
        id: 'evt_tool_call',
        type: 'tool_call',
        call,
        createdAt: call.requestedAt,
      },
    ],
  };

  const next = applyToolResult(thread, deniedResult, deniedGrant);
  const toolEvent = next.events.find((event) => event.type === 'tool_call');
  const evidenceEvent = next.events.find((event) => event.type === 'evidence_summary');
  const artifactEvent = next.events.find((event) => event.type === 'artifact');

  assert.equal(toolEvent?.type, 'tool_call');
  if (toolEvent?.type === 'tool_call') {
    assert.equal(toolEvent.result?.status, 'denied');
    assert.equal(toolEvent.grant?.granted, false);
  }
  assert.equal(evidenceEvent?.id, 'evt_evidence_evidence_denied');
  assert.equal(artifactEvent?.id, 'evt_artifact_evidence_denied');
  if (artifactEvent?.type === 'artifact') {
    assert.match(artifactEvent.description, /returned to the cloud runtime/i);
  }
});
