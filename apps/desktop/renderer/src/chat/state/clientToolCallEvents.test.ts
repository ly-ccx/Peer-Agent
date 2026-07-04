import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatStreamEvent } from '@peer-agent/protocol';
import { normalizeClientToolCall } from './clientToolCallEvents.ts';

// 钉死 backend 实际推的事件名(cbu-xiaoer-node-service ClientToolEventTypes.ts
// CLIENT_TOOL_EVENT_NAMES.dispatching = 'client_tool_dispatching')。曾经因为这里
// 只认 client_tool_call/.created 而 backend 推 client_tool_dispatching,导致
// dev-mode auto-approve 永远拿不到 ClientToolCall,工具调用全卡死。
test('normalizeClientToolCall extracts ClientToolCall from v3 client_tool_dispatching event', () => {
  const event: ChatStreamEvent = {
    event: 'client_tool_dispatching',
    data: {
      toolCallId: 'tc_42',
      suspensionUuid: 'sp_42',
      capabilityId: 'local.shell.exec',
      toolName: 'local_shell_exec',
      occurredAt: '2026-05-27T11:30:00.000Z',
      displayName: '本地 Shell 执行',
      argumentsPreview: { command: 'cat /tmp/x.txt' },
      confirmation: {
        kind: 'high_risk',
        detail: 'local_shell_exec',
        reason: 'goal_high_risk_confirmation',
        riskLevel: 'L4_privileged',
      },
      policyContext: {
        dataLevel: 'D1_internal',
        riskLevel: 'L2_destructive',
        requiresUserConsent: false,
        reason: 'shell exec requested',
      },
      expiresAt: '2026-05-27T11:35:00.000Z',
    },
  };
  const call = normalizeClientToolCall(event);
  assert.ok(call, 'expected non-null call');
  assert.equal(call!.toolCallId, 'tc_42');
  assert.equal(call!.capabilityId, 'local.shell.exec');
  assert.equal(call!.displayName, '本地 Shell 执行');
  assert.deepEqual(call!.argumentsPreview, { command: 'cat /tmp/x.txt' });
  assert.equal(call!.confirmation?.kind, 'high_risk');
  assert.equal(call!.confirmation?.reason, 'goal_high_risk_confirmation');
  assert.equal(call!.riskLevel, 'L2_destructive');
  assert.equal(call!.dataLevel, 'D1_internal');
  assert.equal(call!.requestedAt, '2026-05-27T11:30:00.000Z');
});

test('normalizeClientToolCall still handles legacy client_tool_call.created with policySnapshot', () => {
  const event: ChatStreamEvent = {
    event: 'client_tool_call.created',
    data: {
      call: {
        toolCallId: 'tc_legacy',
        capabilityId: 'local.health',
        displayName: 'Local Health',
        arguments: { ping: true },
        policySnapshot: {
          dataLevel: 'D0_public',
          capabilityLevel: 'L0_inert',
        },
      },
    },
  };
  const call = normalizeClientToolCall(event);
  assert.ok(call);
  assert.equal(call!.capabilityId, 'local.health');
  assert.deepEqual(call!.argumentsPreview, { ping: true });
  assert.equal(call!.riskLevel, 'L0_inert');
  assert.equal(call!.dataLevel, 'D0_public');
});

test('normalizeClientToolCall ignores unrelated events', () => {
  assert.equal(
    normalizeClientToolCall({ event: 'agent_run_suspended', data: {} }),
    null,
  );
  assert.equal(
    normalizeClientToolCall({ event: 'stream_paused', data: {} }),
    null,
  );
  assert.equal(
    normalizeClientToolCall({ event: 'message_delta', data: {} }),
    null,
  );
});

test('normalizeClientToolCall returns null when toolCallId or capabilityId missing', () => {
  assert.equal(
    normalizeClientToolCall({
      event: 'client_tool_dispatching',
      data: { capabilityId: 'local.health' },
    }),
    null,
  );
  assert.equal(
    normalizeClientToolCall({
      event: 'client_tool_dispatching',
      data: { toolCallId: 'tc_1' },
    }),
    null,
  );
});
