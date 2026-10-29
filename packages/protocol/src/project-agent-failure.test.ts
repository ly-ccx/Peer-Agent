import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAgentFailureKind, classifyProjectAgentFailure } from './project-agent-failure.ts';

test('classifies host exhaustion codes and legacy cards without matching provider error bodies', () => {
  for (const reason of ['agent_tool_budget_exhausted', 'agent_loop_exhausted: limit',
    '代理暂时不可用：agent_tool_budget_exhausted: 本轮工具调用额度已用完']) {
    assert.equal(projectAgentFailureKind(reason), 'budget_exhausted');
  }
  for (const reason of [null, '', 'agent_tool_budget_exhausted_other',
    '代理暂时不可用：HTTP 400: {"message":"agent_tool_budget_exhausted"}']) {
    assert.equal(projectAgentFailureKind(reason), 'unavailable');
  }
});

test('classifies recoverable host diagnostics and keeps terminal gates closed', () => {
  for (const [reason, kind, retryable] of [
    ['connect timeout after 20000ms (ConnectTimeoutError)', 'response_headers_timeout', true],
    ['provider_stream_idle_timeout: no data', 'stream_interrupted', true],
    ['HTTP 503: service unavailable', 'provider_transient', true],
    ['HTTP 429: slow down', 'rate_limited', true],
    ['fetch failed', 'network', true],
    ['UND_ERR_SOCKET', 'network', true],
    ['net::ERR_PROXY_CONNECTION_FAILED', 'network', true],
    ['ERR_NETWORK_CHANGED net::ERR_NETWORK_CHANGED', 'network', true],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'configuration', false],
    ['HTTP 401: login', 'authentication', false],
    ['HTTP 400: {"message":"execution_outcome_unknown"}', 'invalid_request', false],
    ['execution_outcome_unknown', 'execution_outcome_unknown', false],
    ['permission_revoked', 'permission', false],
    ['work_budget_limited', 'budget_exhausted', false],
    ['work_execution_stopped', 'cancelled', false],
    ['ERR_CERT_AUTHORITY_INVALID', 'configuration', false],
    ['unknown error', 'fatal', false],
  ] as const) assert.deepEqual(classifyProjectAgentFailure(reason), { kind, retryable });
});

test('typed host metadata takes precedence without making terminal failures retryable', () => {
  assert.deepEqual(classifyProjectAgentFailure('opaque provider body', { kind: 'network', retryable: true }), { kind: 'network', retryable: true });
  assert.deepEqual(classifyProjectAgentFailure('fetch failed', { kind: 'permission', retryable: true }), { kind: 'permission', retryable: false });
  assert.deepEqual(classifyProjectAgentFailure('fetch failed', { kind: 'network', retryable: false }), { kind: 'network', retryable: false });
  assert.deepEqual(classifyProjectAgentFailure('fetch failed', { kind: 'invented', retryable: true }), { kind: 'network', retryable: true });
});
