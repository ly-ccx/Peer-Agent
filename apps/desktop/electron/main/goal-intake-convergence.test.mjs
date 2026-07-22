import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideIntakeConvergence,
  isIntakeContract,
  shouldAutoStartAcceptedGoalRunner,
} from './goal-intake-convergence.mjs';

const intakePlan = { planId: 'p1', activation: { kind: 'intake' } };

test('isIntakeContract 只认 activation.kind==="intake"', () => {
  assert.equal(isIntakeContract(intakePlan), true);
  assert.equal(isIntakeContract({ activation: { kind: 'accepted_goal' } }), false);
  assert.equal(isIntakeContract(null), false);
  assert.equal(isIntakeContract({}), false);
});

test('纯问答/咨询：intake 契约 + 正常结束 + 未提问 → remove', () => {
  const decision = decideIntakeConvergence(intakePlan, {
    terminalStatus: 'done',
    requestedUserInput: false,
  });
  assert.equal(decision, 'remove');
});

test('模糊澄清：模型调用 request_user_input → keep（保留等待）', () => {
  const decision = decideIntakeConvergence(intakePlan, {
    terminalStatus: 'done',
    requestedUserInput: true,
  });
  assert.equal(decision, 'keep');
});

test('回合出错 → keep（不误删，交既有失败链路）', () => {
  assert.equal(
    decideIntakeConvergence(intakePlan, { terminalStatus: 'error' }),
    'keep',
  );
});

test('回合中止 → keep（不误删）', () => {
  assert.equal(
    decideIntakeConvergence(intakePlan, { terminalStatus: 'aborted' }),
    'keep',
  );
});

test('明确目标：契约已被 goal_create_plan 升级为 accepted_goal → skip', () => {
  const upgraded = { planId: 'p1', activation: { kind: 'accepted_goal' } };
  assert.equal(
    decideIntakeConvergence(upgraded, { terminalStatus: 'done', requestedUserInput: false }),
    'skip',
  );
});

test('无活动契约（null）→ skip', () => {
  assert.equal(decideIntakeConvergence(null, { terminalStatus: 'done' }), 'skip');
});

test('outcome 缺失时对 intake 契约仍按正常结束处理 → remove', () => {
  // terminalStatus/requestedUserInput 均为 undefined：非 error/aborted、未提问 → 视为纯问答。
  assert.equal(decideIntakeConvergence(intakePlan, undefined), 'remove');
  assert.equal(decideIntakeConvergence(intakePlan, {}), 'remove');
});

test('shouldAutoStartAcceptedGoalRunner: accepted_goal + accepted/executing 都要启动', () => {
  assert.equal(
    shouldAutoStartAcceptedGoalRunner({
      workflowKind: 'goal_self_driven',
      activation: { kind: 'accepted_goal' },
      status: 'accepted',
    }),
    true,
  );
  // 回归：intake 升级后 status 仍可能是 executing，旧逻辑只认 accepted 会漏启动 Runner。
  assert.equal(
    shouldAutoStartAcceptedGoalRunner({
      workflowKind: 'goal_self_driven',
      activation: { kind: 'accepted_goal' },
      status: 'executing',
    }),
    true,
  );
});

test('shouldAutoStartAcceptedGoalRunner: intake / 非自驱 / 终态 不启动', () => {
  assert.equal(
    shouldAutoStartAcceptedGoalRunner({
      workflowKind: 'goal_self_driven',
      activation: { kind: 'intake' },
      status: 'executing',
    }),
    false,
  );
  assert.equal(
    shouldAutoStartAcceptedGoalRunner({
      workflowKind: 'plan_approval',
      activation: { kind: 'accepted_goal' },
      status: 'accepted',
    }),
    false,
  );
  assert.equal(
    shouldAutoStartAcceptedGoalRunner({
      workflowKind: 'goal_self_driven',
      activation: { kind: 'accepted_goal' },
      status: 'completed',
    }),
    false,
  );
  assert.equal(shouldAutoStartAcceptedGoalRunner(null), false);
});
