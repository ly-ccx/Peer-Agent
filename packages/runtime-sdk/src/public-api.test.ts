import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  createRuntimePipeline,
  createRuntimeSdk,
  createRuntimeSessionController,
  type RuntimeExecuteRequest,
  type RuntimeExecutionContext,
  type RuntimeSdkExecuteRequest,
  type RuntimeSdkExecutionContext,
  type RuntimeSdkToolCall,
  type RuntimeSdkToolResult,
  type RuntimeToolCall,
  type RuntimeToolResult,
} from './index.ts';

function assertSameType<T>(_left: T, _right: T): void {}

test('exposes the stable runtime factories and event protocol version', () => {
  assert.equal(RUNTIME_EVENT_PROTOCOL_VERSION, 1);
  assert.equal(typeof createRuntimeSdk, 'function');
  assert.equal(typeof createRuntimePipeline, 'function');
  assert.equal(typeof createRuntimeSessionController, 'function');
});

test('keeps legacy SDK contract names aligned with protocol-owned contracts', () => {
  const call: RuntimeToolCall = {
    toolCallId: 'tool-1',
    capabilityId: 'local.test',
    arguments: { value: 1 },
  };
  const result: RuntimeToolResult = {
    toolCallId: 'tool-1',
    status: 'success',
    evidence: { evidenceId: 'evidence-1' },
  };
  const request: RuntimeExecuteRequest = {
    sessionId: 'session-1',
    call,
  };
  const context: RuntimeExecutionContext = {
    workspaceRoot: '/workspace',
  };

  assertSameType<RuntimeSdkToolCall>(call, call);
  assertSameType<RuntimeToolCall>(call as RuntimeSdkToolCall, call);
  assertSameType<RuntimeSdkToolResult>(result, result);
  assertSameType<RuntimeToolResult>(result as RuntimeSdkToolResult, result);
  assertSameType<RuntimeSdkExecuteRequest>(request, request);
  assertSameType<RuntimeExecuteRequest>(request as RuntimeSdkExecuteRequest, request);
  assertSameType<RuntimeSdkExecutionContext>(context, context);
  assertSameType<RuntimeExecutionContext>(
    context as RuntimeSdkExecutionContext,
    context,
  );

  assert.equal(request.call, call);
  assert.equal(result.status, 'success');
});
