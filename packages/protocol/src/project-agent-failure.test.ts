import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAgentFailureKind } from './project-agent-failure.ts';

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
